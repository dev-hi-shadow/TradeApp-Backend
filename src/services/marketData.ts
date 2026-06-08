/**
 * Market-data facade.
 *
 * The rest of the app (WS broadcaster, order engine, REST routes) only ever
 * talks to this module. It delegates to Angel One SmartAPI (primary for all
 * NSE/BSE/MCX + options), and falls back to the pluggable market-data provider
 * chain (services/providers: Twelve Data → … → Yahoo last) for the cash-equity
 * / index slice when Angel can't serve a symbol.
 */
import { angel } from './angelOne';
import { angelEnabled } from '../config/env';
import { scripMaster } from './scripMaster';
import { cacheGet, cacheSet } from './cache';
import { providerGetQuotes, providerGetHistory, providerSearch } from './providers/registry';
import { toYahooSymbol, toDisplaySymbol } from './providers/symbols';

// Symbol helpers now live in providers/symbols (shared with the provider layer).
// Re-exported here so existing importers (orderEngine, routes, ws) are unaffected.
export { toYahooSymbol, toDisplaySymbol };

export interface Quote {
  symbol: string;          // Yahoo-style key kept for cache compatibility ("RELIANCE.NS")
  displaySymbol: string;   // What users see ("RELIANCE", "NIFTY", "GOLD")
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  currency?: string;
  exchange?: string;
  timestamp: number;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ---------- Shared cache (~450 ms TTL) ----------
// L1: in-process map for sub-ms reads on the hot path.
// L2: Redis (Valkey) cross-process for multi-replica deploys and to absorb
// burst load when an order is placed at the same instant a chain refresh
// fires. The Redis TTL is the same as the in-process TTL — L1 evicts on
// its own, L2 evicts via PX.
const quoteCache = new Map<string, { quote: Quote; fetchedAt: number }>();
// At a 500 ms tick interval, 450 ms TTL means every other tick hits the
// upstream (Angel/Yahoo) — enough freshness for the UI without melting the
// broker's rate budget. Concurrent fetches dedup via the `inflight` map.
const CACHE_TTL = 450;

// Per-yahoo-symbol inflight promise dedup. Two simultaneous fetchQuotes
// calls (e.g. a market tick and a user order placed in the same window) for
// the SAME symbol will share one upstream call instead of racing.
const inflight = new Map<string, Promise<Quote | null>>();

// "Last known good" map — NO expiry. Stores the most recent successful
// quote per symbol forever (until process restart). Lets the option-chain
// route compute an ATM strike from a 30 s stale spot rather than failing
// with a 503 when Angel + Yahoo are both rate-limited mid-tick. The TTL'd
// cache above still drives freshness for normal serving; this is purely
// the floor for never-fail reads.
const lastKnownPrice = new Map<string, {
  price: number;
  at: number;
  // Day-change basis remembered from the last GOOD quote, so the LKG
  // fallback can serve a complete quote during rate-limit windows instead
  // of emitting change=0 (which made the UI's change% flip to "+0.00").
  change?: number;
  changePercent?: number;
  previousClose?: number;
}>();

export function getLastKnownPrice(symbolOrYahoo: string): { price: number; at: number } | null {
  return lastKnownPrice.get(symbolOrYahoo.toUpperCase()) || null;
}

function recordLastKnown(
  displaySymbol: string,
  yahooSymbol: string,
  price: number,
  extra?: { change: number; changePercent: number; previousClose: number },
): void {
  if (!Number.isFinite(price) || price <= 0) return;
  // Keep the last GOOD change basis: a caller that only knows the price (or
  // got a zeroed close from upstream) must not wipe the remembered fields.
  const prev = lastKnownPrice.get(displaySymbol.toUpperCase());
  const basis = extra && extra.previousClose > 0
    ? extra
    : { change: prev?.change, changePercent: prev?.changePercent, previousClose: prev?.previousClose };
  const entry = { price, at: Date.now(), ...basis };
  lastKnownPrice.set(displaySymbol.toUpperCase(), entry);
  lastKnownPrice.set(yahooSymbol.toUpperCase(), entry);
}

export function getLatestCached(yahooSymbol: string): Quote | null {
  return quoteCache.get(yahooSymbol)?.quote || null;
}

/**
 * Push a LIVE tick from the Angel SmartWebSocketV2 feed into the SAME caches
 * the REST path writes (L1 quoteCache + L2 Redis + last-known-good). The price
 * loop's `fetchQuotes` reads quoteCache first, so a steady WS feed means the
 * loop serves sub-ms cache hits and never calls Angel REST for that token —
 * which is exactly how this removes the REST rate-limit pressure.
 *
 * LTP-only ticks have no fresh `close`; we reuse the last-known previousClose
 * (seeded by an earlier REST quote) so the day-change stays correct instead of
 * collapsing to 0. Returns the injected Quote, or null if the tick is rejected.
 */
export function injectLiveQuote(
  displaySymbol: string,
  ltp: number,
  opts?: { close?: number; volume?: number; exchange?: string },
): Quote | null {
  if (!Number.isFinite(ltp) || ltp <= 0) return null;
  const display = displaySymbol.toUpperCase();
  const yKey = toYahooSymbol(display);
  const prevQ = quoteCache.get(yKey)?.quote;
  const lkg = lastKnownPrice.get(display);
  const prevClose =
    opts?.close && opts.close > 0
      ? opts.close
      : prevQ?.previousClose && prevQ.previousClose > 0
        ? prevQ.previousClose
        : lkg?.previousClose && lkg.previousClose > 0
          ? lkg.previousClose
          : ltp;
  const change = prevClose > 0 ? ltp - prevClose : 0;
  const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;
  const q: Quote = {
    symbol: yKey,
    displaySymbol: display,
    price: ltp,
    change,
    changePercent,
    previousClose: prevClose,
    exchange: opts?.exchange ?? prevQ?.exchange,
    timestamp: Date.now(),
  };
  quoteCache.set(yKey, { quote: q, fetchedAt: Date.now() });
  cacheSet(`quote:${yKey}`, q, CACHE_TTL).catch(() => {});
  recordLastKnown(display, yKey, ltp, { change, changePercent, previousClose: prevClose });
  return q;
}

// ---------- Live order-book depth (for volume-based fills) ----------
export interface DepthLevel { price: number; quantity: number }
export interface DepthQuote {
  symbol: string;
  ltp: number;
  totalBuyQty: number;
  totalSellQty: number;
  volume: number;
  /** Bids, best (highest) first. */
  buy: DepthLevel[];
  /** Asks, best (lowest) first. */
  sell: DepthLevel[];
}

// Short cache so the limit matcher / repeated fills in one window don't refetch
// the full (heavier) depth quote every single tick.
const depthCache = new Map<string, { q: DepthQuote; at: number }>();
const DEPTH_TTL = 700;

/**
 * Cache-ONLY depth read (no network). Used on the hot order-fill path so a
 * fill never blocks on an upstream Angel call — keeps exits in milliseconds.
 * Returns recently-cached depth (within `maxAgeMs`, default 5s) or null.
 */
export function getDepthCached(symbol: string, maxAgeMs = 5000): DepthQuote | null {
  const c = depthCache.get(symbol.toUpperCase());
  if (c && Date.now() - c.at < maxAgeMs) return c.q;
  return null;
}

/**
 * Fetch the live 5-level order book for ANY tradable symbol — equity, futures,
 * and option contracts (CE/PE), via Angel FULL mode (getQuotesFull resolves the
 * token, including options). Returns null when depth is unavailable (Angel
 * disabled, FULL-mode not subscribed → falls back to no book, or symbol not on
 * Angel). Callers degrade to the synthetic slippage model in that case.
 */
/** Parse one Angel FULL-mode row into a normalised, best-first DepthQuote. */
function buildDepthFromRow(r: any, fallbackKey?: string): DepthQuote | null {
  if (!r || r.ltp == null) return null;
  const key = String(r.input || fallbackKey || '').toUpperCase();
  if (!key) return null;
  const norm = (arr: any): DepthLevel[] =>
    Array.isArray(arr)
      ? arr
          .map((l: any) => ({ price: Number(l.price), quantity: Number(l.quantity) }))
          .filter((l) => l.price > 0 && l.quantity > 0)
      : [];
  const buy = norm(r.depth?.buy).sort((a, b) => b.price - a.price); // bids high→low
  const sell = norm(r.depth?.sell).sort((a, b) => a.price - b.price); // asks low→high
  return {
    symbol: key,
    ltp: Number(r.ltp),
    totalBuyQty: Number(r.totBuyQuan ?? 0),
    totalSellQty: Number(r.totSellQuan ?? 0),
    volume: Number(r.tradeVolume ?? 0),
    buy,
    sell,
  };
}

export async function fetchDepthQuote(symbol: string): Promise<DepthQuote | null> {
  const key = symbol.toUpperCase();
  const cached = depthCache.get(key);
  if (cached && Date.now() - cached.at < DEPTH_TTL) return cached.q;
  if (!angelEnabled) return null;
  try {
    const rows = await angel.getQuotesFull([symbol]);
    const q = buildDepthFromRow(rows[0], key);
    if (!q) return null;
    depthCache.set(key, { q, at: Date.now() });
    return q;
  } catch (err: any) {
    console.error('[marketData] depth fetch failed:', err.message || err);
    return null;
  }
}

/**
 * Proactively WARM the depth cache (one batched Angel FULL call) for the
 * symbols that can be FILLED — so the cache-only hot fill path
 * (`getDepthCached` → `walkBook`) actually walks the REAL order book against
 * real available volume, instead of silently degrading to the synthetic model.
 *
 * Fire-and-forget from the price loop. Skips symbols already fresh within
 * `freshMs` (default 3s) so it refreshes roughly every other 1.5s tick, which
 * keeps every entry inside getDepthCached's 5s window WITHOUT doubling the
 * upstream call rate (Angel FULL mode is throttle-prone). Errors are swallowed
 * — a failed warm just means that fill uses the synthetic fallback.
 */
export async function warmDepth(symbols: string[], freshMs = 3000): Promise<void> {
  if (!angelEnabled || symbols.length === 0) return;
  const now = Date.now();
  const stale = uniqUpper(symbols).filter((s) => {
    const c = depthCache.get(s);
    return !c || now - c.at >= freshMs;
  });
  if (stale.length === 0) return;
  try {
    // Angel quote API caps at 50 tokens/call; warm the most we safely can.
    const rows = await angel.getQuotesFull(stale.slice(0, 50));
    for (const r of rows) {
      const q = buildDepthFromRow(r);
      if (q) depthCache.set(q.symbol, { q, at: Date.now() });
    }
  } catch (err: any) {
    console.error('[marketData] warmDepth failed:', err.message || err);
  }
}

function uniqUpper(arr: string[]): string[] {
  return Array.from(new Set(arr.map((s) => s.toUpperCase())));
}

// ---------- Provider fallback (behind Angel) ----------
// The cash-equity / index fallback now goes through the pluggable provider
// registry (Twelve Data → … → Yahoo last), not Yahoo directly. Angel One stays
// the primary source for everything; this only fills gaps Angel can't serve.

// ---------- Main entry point ----------
export async function fetchQuotes(displaySymbols: string[]): Promise<Quote[]> {
  if (displaySymbols.length === 0) return [];
  const now = Date.now();

  // 1. Serve cached symbols first (L1 in-process, then L2 Redis)
  const needFetch: string[] = [];
  const cached: Quote[] = [];
  // Pull L2 in parallel for anything that misses L1 — keeps the hot path fast.
  const l1Misses: string[] = [];
  for (const sym of displaySymbols) {
    const key = toYahooSymbol(sym);
    const entry = quoteCache.get(key);
    if (entry && now - entry.fetchedAt < CACHE_TTL) {
      cached.push(entry.quote);
    } else {
      l1Misses.push(sym);
    }
  }
  if (l1Misses.length) {
    const l2Results = await Promise.all(
      l1Misses.map(async (sym) => {
        const key = toYahooSymbol(sym);
        const q = await cacheGet<Quote>(`quote:${key}`);
        return { sym, key, q };
      }),
    );
    for (const r of l2Results) {
      if (r.q) {
        // Promote L2 hit into L1 so subsequent same-tick reads are sub-ms.
        quoteCache.set(r.key, { quote: r.q, fetchedAt: now });
        cached.push(r.q);
      } else {
        needFetch.push(r.sym);
      }
    }
  }
  if (!needFetch.length) return cached;

  // 2. Try Angel One (batched, fast, no rate limit)
  let fresh: Quote[] = [];
  let unresolved = needFetch;
  if (angelEnabled) {
    try {
      const angelQuotes = await angel.getQuotes(needFetch);
      const fetchedDisplays = new Set<string>();
      for (const aq of angelQuotes) {
        const q: Quote = {
          symbol: aq.yahooSymbol,
          displaySymbol: aq.symbol,
          price: aq.ltp,
          change: aq.change,
          changePercent: aq.changePercent,
          previousClose: aq.close,
          exchange: aq.exchange,
          timestamp: aq.timestamp,
        };
        quoteCache.set(aq.yahooSymbol, { quote: q, fetchedAt: now });
        cacheSet(`quote:${aq.yahooSymbol}`, q, CACHE_TTL).catch(() => {});
        recordLastKnown(aq.symbol, aq.yahooSymbol, aq.ltp, {
          change: aq.change, changePercent: aq.changePercent, previousClose: aq.close,
        });
        fresh.push(q);
        fetchedDisplays.add(aq.symbol.toUpperCase());
      }
      unresolved = needFetch.filter((s) => !fetchedDisplays.has(s.toUpperCase()));
    } catch (err: any) {
      console.error('[marketData] angel quote error:', err.message || err);
    }
  }

  // 2b. Option-contract fallback — Angel's display-symbol resolver doesn't
  // index individual option contracts (NIFTY26MAY2623650CE etc.), so we
  // resolve them via the scrip master and hit the token-quote API directly.
  // This is the same path the option-chain route uses.
  if (unresolved.length) {
    const optionSyms = unresolved.filter((s) => /\d(?:CE|PE)$/.test(s.toUpperCase()));
    if (optionSyms.length) {
      try {
        const pairs: { exchange: string; token: string; sym: string }[] = [];
        for (const sym of optionSyms) {
          const inst = scripMaster.findOptionByTradingSymbol?.(sym);
          if (inst) pairs.push({ exchange: inst.exch_seg, token: inst.token, sym });
        }
        if (pairs.length && angelEnabled) {
          const rows = await angel.getQuotesByTokens(
            pairs.map((p) => ({ exchange: p.exchange, token: p.token })),
            'FULL',
          );
          const byToken = new Map<string, any>(rows.map((r: any) => [String(r.symbolToken), r]));
          for (const p of pairs) {
            const r = byToken.get(String(p.token));
            if (!r || !r.ltp) continue;
            const q: Quote = {
              symbol: p.sym.toUpperCase(),
              displaySymbol: p.sym.toUpperCase(),
              price: Number(r.ltp),
              change: Number(r.netChange ?? 0),
              changePercent: Number(r.percentChange ?? 0),
              previousClose: Number(r.close ?? 0),
              exchange: p.exchange,
              timestamp: now,
            };
            const yKey = toYahooSymbol(p.sym);
            quoteCache.set(yKey, { quote: q, fetchedAt: now });
            cacheSet(`quote:${yKey}`, q, CACHE_TTL).catch(() => {});
            recordLastKnown(p.sym, yKey, Number(r.ltp), {
              change: q.change, changePercent: q.changePercent, previousClose: q.previousClose,
            });
            fresh.push(q);
          }
          const resolvedSet = new Set(
            pairs
              .filter((p) => byToken.get(String(p.token))?.ltp)
              .map((p) => p.sym.toUpperCase()),
          );
          unresolved = unresolved.filter((s) => !resolvedSet.has(s.toUpperCase()));
        }
      } catch (err: any) {
        // Don't log every failure during a rate-limit storm — the breaker
        // in runQuoteRaw already opens, so subsequent tries no-op cheaply.
        const msg = String(err.message || err);
        if (!/status code 403/.test(msg)) {
          console.error('[marketData] option-token fallback failed:', msg);
        }
      }
    }
  }

  // 3. Fall back to the configured provider chain (Twelve Data → … → Yahoo
  // last) — but ONLY for symbols without a fresh last-known-good price, so an
  // Angel-breaker burst doesn't hammer a provider's rate limit. For symbols
  // with LKG < 60s old we just serve that — same number, no extra HTTP cost.
  if (unresolved.length) {
    const LKG_FRESH_MS = 60_000;
    const toProvider: string[] = [];
    for (const sym of unresolved) {
      const lkg = lastKnownPrice.get(sym.toUpperCase()) || lastKnownPrice.get(toYahooSymbol(sym).toUpperCase());
      if (lkg && now - lkg.at < LKG_FRESH_MS) {
        // Serve the REMEMBERED day-change basis — emitting change:0 here was
        // what made every card flip to "+0.00 (+0.00%)" whenever the Angel
        // rate-limit breaker opened (then back to real values → oscillation).
        fresh.push({
          symbol: toYahooSymbol(sym),
          displaySymbol: sym.toUpperCase(),
          price: lkg.price,
          change: lkg.change ?? 0,
          changePercent: lkg.changePercent ?? 0,
          previousClose: lkg.previousClose ?? lkg.price,
          timestamp: lkg.at,
        });
      } else {
        toProvider.push(sym);
      }
    }
    if (toProvider.length) {
      // The provider chain handles per-provider batching, chart fallback and
      // failover internally (incl. Yahoo as the last resort).
      const provQuotes = await providerGetQuotes(toProvider);
      for (const q of provQuotes) {
        quoteCache.set(q.symbol, { quote: q, fetchedAt: now });
        cacheSet(`quote:${q.symbol}`, q, CACHE_TTL).catch(() => {});
        recordLastKnown(q.displaySymbol, q.symbol, q.price, {
          change: q.change, changePercent: q.changePercent, previousClose: q.previousClose,
        });
        fresh.push(q);
      }
    }
  }

  // 4. ULTIMATE fallback — last-known-good price (no TTL). Lets the UI
  // and the option-chain ATM picker survive a full Angel + Yahoo outage:
  // we hand back a stale-but-real number rather than a 503. Callers can
  // compare `timestamp` to `Date.now()` if they care about freshness.
  const stillUnresolved = displaySymbols.filter((sym) => {
    const u = sym.toUpperCase();
    return !cached.some((q) => q.displaySymbol.toUpperCase() === u)
        && !fresh.some((q) => q.displaySymbol.toUpperCase() === u);
  });
  for (const sym of stillUnresolved) {
    const last = lastKnownPrice.get(sym.toUpperCase());
    if (!last) continue;
    fresh.push({
      symbol: toYahooSymbol(sym),
      displaySymbol: sym.toUpperCase(),
      price: last.price,
      change: 0,
      changePercent: 0,
      previousClose: last.price,
      timestamp: last.at,
    });
  }

  return [...cached, ...fresh];
}

// ---------- History (charts page) ----------
export type Period = '1D' | '1W' | '1M' | '3M' | '6M' | '1Y' | '3Y' | '5Y' | 'ALL';

export async function fetchHistory(
  symbol: string,
  period: Period
): Promise<Candle[]> {
  // Angel One first
  if (angelEnabled) {
    try {
      const candles = await angel.getHistory(symbol, period);
      if (candles.length) return candles;
    } catch (err: any) {
      console.error('[marketData] angel history failed:', err.message || err);
    }
  }
  // Provider fallback (Twelve Data → … → Yahoo last). Returns [] if none can
  // serve it (e.g. options/MCX — Angel-only).
  return providerGetHistory(symbol, period);
}

// ---------- Snapshot (rich FULL quote for the stock-detail page) ----------
export interface Snapshot {
  symbol: string;
  displaySymbol: string;
  tradingSymbol?: string;
  exchange?: string;
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  close: number;          // previous close
  previousClose: number;
  volume?: number;
  weekHigh52?: number;
  weekLow52?: number;
  upperCircuit?: number;
  lowerCircuit?: number;
  totalBuyQty?: number;
  totalSellQty?: number;
  avgPrice?: number;
  openInterest?: number;
  feedTime?: string;
  depth?: { buy: any[]; sell: any[] };
  fallback?: 'yahoo';
}

export async function fetchSnapshot(displaySymbol: string): Promise<Snapshot | null> {
  if (angelEnabled) {
    try {
      const rows = await angel.getQuotesFull([displaySymbol]);
      const q = rows[0];
      if (q && q.ltp != null) {
        const ltp = Number(q.ltp);
        const prev = Number(q.close ?? ltp);
        return {
          symbol: angel.yahooStyleKey(displaySymbol, q.exchange),
          displaySymbol: displaySymbol.toUpperCase(),
          tradingSymbol: q.tradingSymbol,
          exchange: q.exchange,
          price: ltp,
          change: ltp - prev,
          changePercent: prev ? ((ltp - prev) / prev) * 100 : 0,
          open: Number(q.open ?? ltp),
          high: Number(q.high ?? ltp),
          low: Number(q.low ?? ltp),
          close: prev,
          previousClose: prev,
          volume: q.tradeVolume != null ? Number(q.tradeVolume) : undefined,
          weekHigh52: q['52WeekHigh'] != null ? Number(q['52WeekHigh']) : undefined,
          weekLow52: q['52WeekLow'] != null ? Number(q['52WeekLow']) : undefined,
          upperCircuit: q.upperCircuit != null ? Number(q.upperCircuit) : undefined,
          lowerCircuit: q.lowerCircuit != null ? Number(q.lowerCircuit) : undefined,
          totalBuyQty: q.totBuyQuan != null ? Number(q.totBuyQuan) : undefined,
          totalSellQty: q.totSellQuan != null ? Number(q.totSellQuan) : undefined,
          avgPrice: q.avgPrice != null ? Number(q.avgPrice) : undefined,
          openInterest: q.opnInterest != null ? Number(q.opnInterest) : undefined,
          feedTime: q.exchFeedTime,
          depth: q.depth,
        };
      }
    } catch (err: any) {
      console.error('[marketData] angel snapshot failed:', err.message || err);
    }
  }
  // Provider fallback (Twelve Data → … → Yahoo last).
  const yQs = await providerGetQuotes([displaySymbol]);
  const q = yQs[0];
  if (!q) return null;
  return {
    symbol: q.symbol,
    displaySymbol: q.displaySymbol,
    exchange: q.exchange,
    price: q.price,
    change: q.change,
    changePercent: q.changePercent,
    open: q.previousClose,
    high: q.price,
    low: q.price,
    close: q.previousClose,
    previousClose: q.previousClose,
    fallback: 'yahoo',
  };
}

// ---------- Symbol search ----------
//
// First-pass: scan the locally-cached Angel scrip master (10 k cash equities,
// fuzzy on both symbol + name — instant). If that has no hits we fall back
// to Angel's REST searchScrip, and finally the provider chain's search.
//
export async function searchSymbols(
  query: string,
): Promise<{ symbol: string; name: string; exchange?: string }[]> {
  const q = query.trim();
  if (!q) return [];

  // 1. Local scrip-master (fastest, broadest equity coverage)
  try {
    await scripMaster.ensure();
    const local = scripMaster.searchEquities(q, 12);
    if (local.length) return local;
  } catch (err: any) {
    console.warn('[marketData] scrip-master search failed:', err.message);
  }

  // 2. Angel REST search (covers F&O / commodity contracts)
  if (angelEnabled) {
    try {
      const rest = await angel.searchInstruments(q, 10);
      if (rest.length) return rest;
    } catch {
      /* fall through */
    }
  }

  // 3. Provider fallback (Twelve Data → … → Yahoo last) for anything the
  // local scrip master + Angel search didn't cover (e.g. US tickers).
  return providerSearch(q);
}
