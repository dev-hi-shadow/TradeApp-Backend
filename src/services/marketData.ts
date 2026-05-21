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

// ---------- Shared cache (1.5 s TTL) ----------
const quoteCache = new Map<string, { quote: Quote; fetchedAt: number }>();
// At a 500 ms tick interval the cache TTL controls how many ticks serve
// from memory before we hit Angel again. 1200 ms ≈ every 3rd tick hits
// the wire — enough freshness for the UI without burning rate limits.
const CACHE_TTL = 1200;

export function getLatestCached(yahooSymbol: string): Quote | null {
  return quoteCache.get(yahooSymbol)?.quote || null;
}

// ---------- Yahoo fallback ----------
// Circuit breaker: when Yahoo 429s us (and at 500 ms tick that's basically
// guaranteed if Angel ever fails), back off for 60 s instead of hammering
// it on every subsequent tick — otherwise the log fills with rate-limit
// noise and we burn CPU on guaranteed failures.
let yahooBreakerOpenUntil = 0;

async function yahooBatch(displaySymbols: string[]): Promise<Quote[]> {
  if (!displaySymbols.length) return [];
  if (Date.now() < yahooBreakerOpenUntil) return [];
  const yahooSymbols = Array.from(new Set(displaySymbols.map(toYahooSymbol)));
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
      yahooBreakerOpenUntil = Date.now() + 60_000;
      console.warn('[marketData] yahoo rate-limited, breaker open for 60s');
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

  // 1. Serve cached symbols first
  const needFetch: string[] = [];
  const cached: Quote[] = [];
  for (const sym of displaySymbols) {
    const key = toYahooSymbol(sym);
    const entry = quoteCache.get(key);
    if (entry && now - entry.fetchedAt < CACHE_TTL) {
      cached.push(entry.quote);
    } else {
      needFetch.push(sym);
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
            quoteCache.set(toYahooSymbol(p.sym), { quote: q, fetchedAt: now });
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

  // 3. Fall back to Yahoo for whatever Angel + scripMaster couldn't resolve
  if (unresolved.length) {
    const yQuotes = await yahooBatch(unresolved);
    const got = new Set(yQuotes.map((q) => q.symbol));
    for (const q of yQuotes) {
      quoteCache.set(q.symbol, { quote: q, fetchedAt: now });
      fresh.push(q);
    }
    // Per-symbol chart fallback for any still missing
    const stillMissing = unresolved
      .map(toYahooSymbol)
      .filter((y) => !got.has(y));
    if (stillMissing.length) {
      const more = await Promise.all(
        stillMissing.map((y) => yahooChartFallback(toDisplaySymbol(y)))
      );
      for (const q of more) {
        if (q) {
          quoteCache.set(q.symbol, { quote: q, fetchedAt: now });
          fresh.push(q);
        }
      }
    }
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
  switch (period) {
    case '1D':  period1.setDate(now.getDate() - 1);          interval = '5m';  break;
    case '1W':  period1.setDate(now.getDate() - 7);          interval = '15m'; break;
    case '1M':  period1.setMonth(now.getMonth() - 1);        interval = '1h';  break;
    case '3M':  period1.setMonth(now.getMonth() - 3);        interval = '1d';  break;
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
