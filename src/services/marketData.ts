/**
 * Market-data facade.
 *
 * The rest of the app (WS broadcaster, order engine, REST routes) only ever
 * talks to this module. It in turn delegates to Angel One SmartAPI when
 * credentials are configured, with a yahoo-finance2 fallback for symbols
 * Angel doesn't cover (US stocks, crypto, etc).
 */
import yahooFinance from 'yahoo-finance2';
import { angel } from './angelOne';
import { angelEnabled } from '../config/env';
import { scripMaster } from './scripMaster';
import { cacheGet, cacheSet } from './cache';

// Silence Yahoo's noisy survey banner
try {
  (yahooFinance as any).suppressNotices?.(['yahooSurvey']);
} catch {
  /* older versions may not have this */
}

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

// ---------- Yahoo alias map (used for fallback) ----------
const SYMBOL_ALIASES: Record<string, string> = {
  NIFTY: '^NSEI',
  'NIFTY 50': '^NSEI',
  SENSEX: '^BSESN',
  'GIFT NIFTY': 'NIFTY_F1.NS',
  GOLD: 'GC=F',
  SILVER: 'SI=F',
  BANKNIFTY: '^NSEBANK',
};
const REVERSE_ALIAS: Record<string, string> = Object.entries(SYMBOL_ALIASES).reduce(
  (a, [k, v]) => ((a[v] = k), a),
  {} as Record<string, string>
);

export function toYahooSymbol(symbol: string): string {
  const upper = symbol.toUpperCase().trim();
  if (SYMBOL_ALIASES[upper]) return SYMBOL_ALIASES[upper];
  if (/^[A-Z0-9&-]+$/.test(upper) && !upper.includes('.') && !upper.includes('^') && !upper.includes('=')) {
    return `${upper}.NS`;
  }
  return upper;
}
export function toDisplaySymbol(yahooSymbol: string): string {
  if (REVERSE_ALIAS[yahooSymbol]) return REVERSE_ALIAS[yahooSymbol];
  return yahooSymbol.replace('.NS', '').replace('.BO', '');
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
const lastKnownPrice = new Map<string, { price: number; at: number }>();

export function getLastKnownPrice(symbolOrYahoo: string): { price: number; at: number } | null {
  return lastKnownPrice.get(symbolOrYahoo.toUpperCase()) || null;
}

function recordLastKnown(displaySymbol: string, yahooSymbol: string, price: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  const entry = { price, at: Date.now() };
  lastKnownPrice.set(displaySymbol.toUpperCase(), entry);
  lastKnownPrice.set(yahooSymbol.toUpperCase(), entry);
}

export function getLatestCached(yahooSymbol: string): Quote | null {
  return quoteCache.get(yahooSymbol)?.quote || null;
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

// ---------- Yahoo fallback ----------
// Circuit breaker: when Yahoo 429s us (and at 500 ms tick that's basically
// guaranteed if Angel ever fails), back off for 60 s instead of hammering
// it on every subsequent tick — otherwise the log fills with rate-limit
// noise and we burn CPU on guaranteed failures.
let yahooBreakerOpenUntil = 0;

/**
 * Yahoo has cash equities + indices, but NOT NSE/BSE option contracts, futures,
 * MCX commodities, or currency pairs. Trying those just appends ".NS" to e.g.
 * "SENSEX…CE" → a guaranteed 404 that burns the rate-limit budget and trips the
 * breaker. So skip them — Angel + last-known-good covers those.
 */
function isYahooEligible(displaySymbol: string): boolean {
  const s = displaySymbol.toUpperCase();
  if (/\d(?:CE|PE)$/.test(s)) return false; // option contracts
  if (/FUT$/.test(s)) return false;          // futures
  if (/^(GOLD|SILVER|CRUDEOIL|NATURALGAS|COPPER|ZINC|LEAD|ALUMINIUM)/.test(s)) return false; // MCX
  return true;
}

async function yahooBatch(displaySymbols: string[]): Promise<Quote[]> {
  const eligible = displaySymbols.filter(isYahooEligible);
  if (!eligible.length) return [];
  if (Date.now() < yahooBreakerOpenUntil) return [];
  const yahooSymbols = Array.from(new Set(eligible.map(toYahooSymbol)));
  const now = Date.now();
  try {
    const result: any = await yahooFinance.quote(yahooSymbols);
    const list: any[] = Array.isArray(result) ? result : [result];
    return list
      .filter((q: any) => q && (q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice) != null)
      .map((q: any) => {
        const price =
          q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice ?? q.previousClose ?? 0;
        const prev = q.regularMarketPreviousClose ?? q.previousClose ?? price;
        const change = price - prev;
        const quote: Quote = {
          symbol: q.symbol,
          displaySymbol: toDisplaySymbol(q.symbol),
          price,
          change,
          changePercent: prev ? (change / prev) * 100 : 0,
          previousClose: prev,
          currency: q.currency,
          exchange: q.fullExchangeName,
          timestamp: now,
        };
        return quote;
      });
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (/too many requests|429/i.test(msg)) {
      if (Date.now() >= yahooBreakerOpenUntil) {
        console.warn('[marketData] yahoo rate-limited, breaker open for 60s');
      }
      yahooBreakerOpenUntil = Date.now() + 60_000;
    } else {
      console.error('[marketData] yahoo fallback failed:', msg);
    }
    return [];
  }
}

// Yahoo's chart endpoint is more permissive than v7/quote — try it per-symbol.
// Honours the same breaker as `yahooBatch` so a 429 from one path doesn't
// keep hammering the other path on every tick (yahoo-finance2 probes
// finance.yahoo.com/quote/AAPL internally to refresh its crumb cookie,
// which fails repeatedly during a rate-limit window).
async function yahooChartFallback(displaySymbol: string): Promise<Quote | null> {
  if (!isYahooEligible(displaySymbol)) return null;
  if (Date.now() < yahooBreakerOpenUntil) return null;
  const yahooSymbol = toYahooSymbol(displaySymbol);
  const now = Date.now();
  try {
    const res: any = await yahooFinance.chart(yahooSymbol, {
      period1: new Date(now - 1000 * 60 * 60 * 24 * 2),
      period2: new Date(now),
      interval: '5m',
    });
    const meta = res?.meta;
    const quotes: any[] = res?.quotes || [];
    const last = [...quotes].reverse().find((q) => q?.close != null);
    const price = last?.close ?? meta?.regularMarketPrice;
    if (price == null) return null;
    const prev = meta?.chartPreviousClose ?? meta?.previousClose ?? price;
    const change = price - prev;
    return {
      symbol: yahooSymbol,
      displaySymbol: toDisplaySymbol(yahooSymbol),
      price,
      change,
      changePercent: prev ? (change / prev) * 100 : 0,
      previousClose: prev,
      currency: meta?.currency,
      exchange: meta?.exchangeName,
      timestamp: now,
    };
  } catch (err: any) {
    const msg = String(err?.message || err);
    if (/too many requests|429|finance\.yahoo\.com\/quote/i.test(msg)) {
      yahooBreakerOpenUntil = Date.now() + 60_000;
    }
    return null;
  }
}

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
        recordLastKnown(aq.symbol, aq.yahooSymbol, aq.ltp);
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
            recordLastKnown(p.sym, yKey, Number(r.ltp));
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

  // 3. Fall back to Yahoo — but ONLY for symbols that don't already have a
  // last-known-good price recent enough to serve. When Angel's breaker is
  // open, sending all 20+ subscribed symbols to Yahoo at once is what trips
  // Yahoo's 60 s breaker (the "rate-limited, breaker open for 60s" we saw
  // in logs). For symbols with LKG < 60s old we just serve that — it's the
  // same number Yahoo would have given us anyway, with no extra HTTP cost.
  if (unresolved.length) {
    const LKG_FRESH_MS = 60_000;
    const toYahoo: string[] = [];
    for (const sym of unresolved) {
      const lkg = lastKnownPrice.get(sym.toUpperCase()) || lastKnownPrice.get(toYahooSymbol(sym).toUpperCase());
      if (lkg && now - lkg.at < LKG_FRESH_MS) {
        fresh.push({
          symbol: toYahooSymbol(sym),
          displaySymbol: sym.toUpperCase(),
          price: lkg.price,
          change: 0,
          changePercent: 0,
          previousClose: lkg.price,
          timestamp: lkg.at,
        });
      } else {
        toYahoo.push(sym);
      }
    }
    if (toYahoo.length) {
      const yQuotes = await yahooBatch(toYahoo);
      const got = new Set(yQuotes.map((q) => q.symbol));
      for (const q of yQuotes) {
        quoteCache.set(q.symbol, { quote: q, fetchedAt: now });
        cacheSet(`quote:${q.symbol}`, q, CACHE_TTL).catch(() => {});
        recordLastKnown(q.displaySymbol, q.symbol, q.price);
        fresh.push(q);
      }
      // Per-symbol chart fallback for any still missing
      const stillMissing = toYahoo
        .map(toYahooSymbol)
        .filter((y) => !got.has(y));
      if (stillMissing.length) {
        const more = await Promise.all(
          stillMissing.map((y) => yahooChartFallback(toDisplaySymbol(y)))
        );
        for (const q of more) {
          if (q) {
            quoteCache.set(q.symbol, { quote: q, fetchedAt: now });
            cacheSet(`quote:${q.symbol}`, q, CACHE_TTL).catch(() => {});
            recordLastKnown(q.displaySymbol, q.symbol, q.price);
            fresh.push(q);
          }
        }
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
  // Yahoo fallback
  const yahooSymbol = toYahooSymbol(symbol);
  const now = new Date();
  let period1 = new Date();
  let interval: '1m' | '5m' | '15m' | '1h' | '1d' = '1d';
  // Match Angel's interval grid — 1D uses 1-minute candles for the dense
  // tick-look the user expects on the 1D screen.
  switch (period) {
    case '1D':  period1.setDate(now.getDate() - 1);          interval = '1m';  break;
    case '1W':  period1.setDate(now.getDate() - 7);          interval = '5m';  break;
    case '1M':  period1.setMonth(now.getMonth() - 1);        interval = '15m'; break;
    case '3M':  period1.setMonth(now.getMonth() - 3);        interval = '1h';  break;
    case '6M':  period1.setMonth(now.getMonth() - 6);        interval = '1d';  break;
    case '1Y':  period1.setFullYear(now.getFullYear() - 1);  interval = '1d';  break;
    case '3Y':  period1.setFullYear(now.getFullYear() - 3);  interval = '1d';  break;
    case '5Y':  period1.setFullYear(now.getFullYear() - 5);  interval = '1d';  break;
    case 'ALL': period1.setFullYear(now.getFullYear() - 10); interval = '1d';  break;
  }
  try {
    const result: any = await yahooFinance.chart(yahooSymbol, { period1, period2: now, interval });
    const quotes: any[] = result?.quotes || [];
    return quotes
      .filter((q) => q.close != null && q.open != null)
      .map((q) => ({
        time: Math.floor(new Date(q.date).getTime() / 1000),
        open: q.open,
        high: q.high,
        low: q.low,
        close: q.close,
        volume: q.volume || 0,
      }));
  } catch (err: any) {
    console.error('[marketData] yahoo history error:', err.message || err);
    return [];
  }
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
  // Yahoo fallback
  const yQs = await yahooBatch([displaySymbol]);
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
// to Angel's REST searchScrip, and finally yahoo-finance2's search.
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

  // 3. Yahoo fallback (US tickers etc.)
  try {
    const result: any = await yahooFinance.search(q, { quotesCount: 10 });
    return (result?.quotes || [])
      .filter((x: any) => x.symbol && x.shortname)
      .map((x: any) => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol }));
  } catch (err: any) {
    console.error('[marketData] search error:', err.message || err);
    return [];
  }
}
