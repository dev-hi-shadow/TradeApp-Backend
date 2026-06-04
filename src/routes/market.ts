import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import {
  fetchHistory,
  fetchQuotes,
  fetchSnapshot,
  getLatestCached,
  getLastKnownPrice,
  toYahooSymbol,
  Period,
  searchSymbols,
} from '../services/marketData';
import { scripMaster } from '../services/scripMaster';
import { angel } from '../services/angelOne';
import { angelEnabled } from '../config/env';
import { cacheWrap, cacheGet, cacheSet } from '../services/cache';

const router = Router();

const PERIODS: Period[] = ['1D', '1W', '1M', '3M', '6M', '1Y', '3Y', '5Y', 'ALL'];

router.get('/history', requireAuth, async (req: AuthRequest, res: Response) => {
  const symbol = String(req.query.symbol || '');
  const periodRaw = String(req.query.period || '1D').toUpperCase() as Period;
  const period: Period = PERIODS.includes(periodRaw) ? periodRaw : '1D';
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  // TTL per period — intraday refreshes every 30 s, longer windows cache
  // for minutes. Without this every page mount / period click re-hits Angel
  // (and on a breaker → cascades to Yahoo).
  const ttl =
    period === '1D' ? 30_000 :
    period === '1W' ? 60_000 :
    period === '1M' ? 5 * 60_000 :
                      30 * 60_000;
  const key = `history:${symbol.toUpperCase()}:${period}`;
  const payload = await cacheWrap(
    key,
    ttl,
    async () => {
      const candles = await fetchHistory(symbol, period);
      return { symbol, period, candles };
    },
    // Don't memoise an empty fetch — a single rate-limit failure would
    // otherwise lock the chart blank for the whole TTL.
    (v) => v.candles.length > 0,
  );
  // Last-good layer: when upstream returns EMPTY (rate-limit window), serve
  // the most recent good payload instead of a blank chart. Refreshed on every
  // good fetch; generous TTL since slightly-stale candles beat no candles.
  const lgKey = `history:lg:${key}`;
  if (payload.candles.length > 0) {
    cacheSet(lgKey, payload, 30 * 60_000).catch(() => {});
  } else {
    const lastGood = await cacheGet<typeof payload>(lgKey);
    if (lastGood?.candles?.length) return res.json(lastGood);
  }
  res.json(payload);
});

/**
 * Candles by explicit timeframe — drives the terminal's interval selector.
 * Returns raw bars at the user-selected bucket size. For non-native Angel
 * intervals (2m, 20m, 2h) we fetch the finest matching native bars and
 * aggregate locally — same OHLCV math any broker uses internally.
 *
 *   GET /api/market/candles?symbol=NIFTY&interval=15m
 */
const INTERVAL_PLAN: Record<string, {
  angel: 'ONE_MINUTE' | 'THREE_MINUTE' | 'FIVE_MINUTE' | 'TEN_MINUTE'
       | 'FIFTEEN_MINUTE' | 'THIRTY_MINUTE' | 'ONE_HOUR' | 'ONE_DAY';
  aggregate: number;     // group N native bars into one returned bar
  bucketSeconds: number; // size of one returned bar
  lookbackDays: number;  // history window we request
}> = {
  '1m':  { angel: 'ONE_MINUTE',     aggregate: 1, bucketSeconds:    60, lookbackDays: 2  },
  '2m':  { angel: 'ONE_MINUTE',     aggregate: 2, bucketSeconds:   120, lookbackDays: 3  },
  '3m':  { angel: 'THREE_MINUTE',   aggregate: 1, bucketSeconds:   180, lookbackDays: 3  },
  '5m':  { angel: 'FIVE_MINUTE',    aggregate: 1, bucketSeconds:   300, lookbackDays: 5  },
  '10m': { angel: 'TEN_MINUTE',     aggregate: 1, bucketSeconds:   600, lookbackDays: 7  },
  '15m': { angel: 'FIFTEEN_MINUTE', aggregate: 1, bucketSeconds:   900, lookbackDays: 10 },
  '20m': { angel: 'FIVE_MINUTE',    aggregate: 4, bucketSeconds:  1200, lookbackDays: 10 },
  '30m': { angel: 'THIRTY_MINUTE',  aggregate: 1, bucketSeconds:  1800, lookbackDays: 14 },
  '1h':  { angel: 'ONE_HOUR',       aggregate: 1, bucketSeconds:  3600, lookbackDays: 30 },
  '2h':  { angel: 'ONE_HOUR',       aggregate: 2, bucketSeconds:  7200, lookbackDays: 45 },
};

interface NormalCandle { time: number; open: number; high: number; low: number; close: number; volume: number }

function aggregate(bars: NormalCandle[], factor: number, bucketSec: number): NormalCandle[] {
  if (factor <= 1 || bars.length === 0) return bars;
  const out: NormalCandle[] = [];
  let bucket: NormalCandle | null = null;
  let bucketStart = 0;
  for (const b of bars) {
    const start = Math.floor(b.time / bucketSec) * bucketSec;
    if (!bucket || start !== bucketStart) {
      if (bucket) out.push(bucket);
      bucketStart = start;
      bucket = { time: start, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
    } else {
      bucket.high = Math.max(bucket.high, b.high);
      bucket.low  = Math.min(bucket.low,  b.low);
      bucket.close = b.close;
      bucket.volume += b.volume;
    }
  }
  if (bucket) out.push(bucket);
  return out;
}

router.get('/candles', requireAuth, async (req: AuthRequest, res: Response) => {
  const symbol = String(req.query.symbol || '');
  const intervalRaw = String(req.query.interval || '15m').toLowerCase();
  const plan = INTERVAL_PLAN[intervalRaw];
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  if (!plan)   return res.status(400).json({ error: `Unsupported interval. Use one of: ${Object.keys(INTERVAL_PLAN).join(', ')}` });

  if (!angelEnabled) {
    // No Angel → fall back to the period-based fetcher with the closest
    // matching period. Coarse but keeps the terminal alive in dev.
    const fallbackPeriod: Period = plan.lookbackDays <= 7 ? '1W' : plan.lookbackDays <= 31 ? '1M' : '3M';
    const candles = await fetchHistory(symbol, fallbackPeriod);
    return res.json({ symbol, interval: intervalRaw, bucketSeconds: plan.bucketSeconds, candles });
  }

  // Cache per (symbol, interval). Short TTL — long enough to absorb the
  // terminal's "switch tabs quickly" burst, short enough to refresh between
  // visible bars.
  const cacheKey = `candles:${symbol.toUpperCase()}:${intervalRaw}`;
  const payload = await cacheWrap(
    cacheKey,
    Math.min(plan.bucketSeconds * 1000, 30_000),
    async () => {
      const raw = await angel.getCandles(symbol, plan.angel, plan.lookbackDays);
      const candles = aggregate(raw, plan.aggregate, plan.bucketSeconds);
      return { symbol, interval: intervalRaw, bucketSeconds: plan.bucketSeconds, candles };
    },
    // Skip caching empty payloads — otherwise one rate-limit miss locks
    // the terminal chart blank until the TTL expires.
    (v) => v.candles.length > 0,
  );
  res.json(payload);
});

router.get('/search', requireAuth, async (req: AuthRequest, res: Response) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  // Cache per normalised query for 5 min. Search ranks are deterministic
  // for a given scrip master; this collapses bursts from the search box
  // (one HTTP call per keystroke debounce) into one upstream scan.
  const results = await cacheWrap(`search:${q.toUpperCase()}`, 5 * 60_000, () =>
    searchSymbols(q),
  );
  res.json({ results });
});

router.get('/quote', requireAuth, async (req: AuthRequest, res: Response) => {
  const symbols = String(req.query.symbols || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'symbols required' });
  const quotes = await fetchQuotes(symbols);
  res.json({ quotes });
});

/**
 * Curated liquid-equity universe with live quotes — powers the Discover page
 * (top gainers / losers + screener). Cached ~30s so ranking the whole list
 * doesn't hammer the broker on every view.
 */
const SCREENER_UNIVERSE = [
  'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'INFY', 'TCS', 'AXISBANK', 'KOTAKBANK',
  'BHARTIARTL', 'ITC', 'LT', 'BAJFINANCE', 'WIPRO', 'HCLTECH', 'MARUTI', 'TITAN',
  'ASIANPAINT', 'ADANIENT', 'TATAMOTORS', 'HINDUNILVR', 'SUNPHARMA', 'NTPC', 'POWERGRID',
  'ULTRACEMCO', 'NESTLEIND', 'BAJAJFINSV', 'ONGC', 'TATASTEEL', 'JSWSTEEL', 'COALINDIA',
  'TECHM', 'ADANIPORTS', 'GRASIM', 'HINDALCO', 'DRREDDY', 'CIPLA', 'BPCL', 'BRITANNIA',
  'EICHERMOT', 'HEROMOTOCO', 'INDUSINDBK', 'M&M', 'SBILIFE', 'HDFCLIFE', 'APOLLOHOSP',
  'TATACONSUM', 'SHRIRAMFIN', 'TRENT',
];

router.get('/universe', requireAuth, async (_req: AuthRequest, res: Response) => {
  const cached = await cacheGet<any[]>('market:universe');
  if (cached) return res.json({ stocks: cached, fromCache: true });
  let quotes: any[] = [];
  try {
    quotes = await fetchQuotes(SCREENER_UNIVERSE);
  } catch (err: any) {
    console.error('[market] universe fetch failed:', err.message || err);
  }
  const stocks = quotes
    .filter((q) => q.price > 0)
    .map((q) => ({
      symbol: q.displaySymbol,
      price: q.price,
      change: q.change,
      changePercent: q.changePercent,
      previousClose: q.previousClose,
    }));
  if (stocks.length) await cacheSet('market:universe', stocks, 30_000);
  res.json({ stocks });
});

// Rich snapshot used by the stock-detail page
router.get('/snapshot/:symbol', requireAuth, async (req: AuthRequest, res: Response) => {
  const symbol = String(req.params.symbol || '');
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  // Short-TTL cache: page mounts / tab flips within a few seconds share one
  // Angel FULL-mode call (which is the slow, throttle-prone path). The header
  // price stays live via the WS ticker regardless of this TTL.
  const snap = await cacheWrap(
    `snap:${symbol.toUpperCase()}`,
    4_000,
    () => fetchSnapshot(symbol),
    (v) => v != null,
  );
  if (!snap) return res.status(404).json({ error: 'No data' });
  res.json({ snapshot: snap });
});

// Option chain — { symbol, expiry?, radius? } → { underlying, expiry, spot, rows: [{strike, ce, pe}] }
router.get('/options/:symbol', requireAuth, async (req: AuthRequest, res: Response) => {
  if (!angelEnabled) return res.status(501).json({ error: 'Angel One not configured' });
  const underlying = String(req.params.symbol || '').toUpperCase();
  const requestedExpiry = req.query.expiry ? String(req.query.expiry).toUpperCase() : undefined;
  const radius = Math.min(
    20,
    Math.max(5, parseInt(String(req.query.radius || '10'), 10))
  );

  try {
    await scripMaster.ensure();

    const expiries = scripMaster.getExpiries(underlying);
    if (!expiries.length) {
      return res.status(404).json({ error: `No F&O contracts found for ${underlying}` });
    }
    const expiry = requestedExpiry && expiries.includes(requestedExpiry)
      ? requestedExpiry
      : expiries[0];

    // Spot price (drives ATM selection). Four-tier fallback — we only
    // give up if we've literally never seen a quote for this symbol since
    // the process started. Order is cheapest-first:
    //   1) in-memory cache (sub-ms, 1.2 s freshness)
    //   2) light OHLC quote via Angel (or Yahoo if Angel breaker is open)
    //   3) last-known-good price (no TTL, persists for the process lifetime)
    //   4) 503 (only when literally nothing has ever resolved for this sym)
    let spot = getLatestCached(toYahooSymbol(underlying))?.price ?? 0;
    if (!spot) {
      try {
        const qs = await fetchQuotes([underlying]);
        spot = qs[0]?.price ?? 0;
      } catch { /* fall through */ }
    }
    if (!spot) {
      // After fetchQuotes returns nothing, fetchQuotes' own tier-4 fallback
      // already includes last-known. But if the symbol isn't on any
      // subscription path (rare), poll the LKG map directly.
      spot = getLastKnownPrice(underlying)?.price ?? 0;
    }
    if (!spot) {
      return res.status(503).json({ error: 'Could not fetch spot price for ATM' });
    }

    const slice = scripMaster.getOptionChainSlice(underlying, expiry, spot, radius);

    // Per-token last-known cache. If Angel returns ltp=0 for a token (rate
    // limit / partial fetch) we MUST NOT overwrite the previous good value
    // — that's how the chain ends up showing 0.00 across the board after a
    // buy. Stored in Redis (3s TTL) so even after the page does a hard
    // reload we still have the last real number to fall back to.
    const lastTokenKey = (tok: string) => `opt:tok:${tok}`;

    // Cache the WHOLE chain payload for ~800 ms so concurrent calls
    // (user-buy refetch + 5s page poll firing in the same instant) share one
    // upstream call instead of competing for the broker's rate budget.
    const chainKey = `opt:chain:${underlying}:${expiry}:${radius}:${spot.toFixed(0)}`;
    const cached = await cacheGet<any>(chainKey);
    if (cached) {
      // Always refresh the spot in the cached response so the spot strip
      // stays accurate even when serving the chain from cache.
      return res.json({ ...cached, spot, fromCache: true });
    }

    // Batch quote all CE+PE tokens in this slice
    const pairs: { exchange: string; token: string }[] = [];
    for (const row of slice) {
      if (row.ce) pairs.push({ exchange: row.ce.exch_seg, token: row.ce.token });
      if (row.pe) pairs.push({ exchange: row.pe.exch_seg, token: row.pe.token });
    }
    // FULL mode is required to populate `tradeVolume` and `opnInterest` on
    // each option leg. If the broker account is throttled out of FULL,
    // `runQuoteRaw` transparently falls back to OHLC (volume/OI then come
    // through as 0 — an Angel One limitation, not a client bug).
    // A slow/timed-out broker quote must NOT blank the whole chain. On failure
    // we proceed with no live quotes → each leg falls back to its per-token
    // last-known cache, and if the WHOLE build comes back unpriced we serve the
    // last good chain (below) instead of zeros.
    let quotes: any[] = [];
    try {
      quotes = await angel.getQuotesByTokens(pairs, 'FULL');
    } catch (err: any) {
      console.error('[market] option-chain quote fetch failed (serving cached):', err.message || err);
    }
    const byToken = new Map<string, any>(quotes.map((q: any) => [String(q.symbolToken), q]));

    const legFor = async (
      leg: { symbol: string; token: string; lotsize?: number | string },
    ) => {
      const live = byToken.get(leg.token);
      const liveLtp = Number(live?.ltp ?? 0);
      let ltp = liveLtp;
      let openV = Number(live?.open ?? 0);
      let highV = Number(live?.high ?? 0);
      let lowV  = Number(live?.low ?? 0);
      let closeV = Number(live?.close ?? 0);
      let volume = Number(live?.tradeVolume ?? 0);
      let oi = Number(live?.opnInterest ?? 0);

      // If Angel returned 0/missing for this token, hold on to the prior
      // good value (per-token cache, 30s) instead of flashing 0.00 to the
      // user. This is the single biggest contributor to the "all CE/PE
      // show 0" symptom after a buy.
      if (!liveLtp) {
        const prev = await cacheGet<{ ltp: number; open: number; high: number; low: number; close: number; volume: number; oi: number }>(
          lastTokenKey(leg.token),
        );
        if (prev) {
          ltp = prev.ltp;
          openV = prev.open;
          highV = prev.high;
          lowV = prev.low;
          closeV = prev.close;
          volume = prev.volume;
          oi = prev.oi;
        }
      } else {
        // Snapshot this leg as last-known so the NEXT 0-return tick has a
        // floor to fall back to. 30s TTL is enough to bridge any breaker
        // window without serving truly stale data on a long outage.
        await cacheSet(lastTokenKey(leg.token), {
          ltp: liveLtp, open: openV, high: highV, low: lowV,
          close: closeV, volume, oi,
        }, 30_000);
      }
      return {
        symbol: leg.symbol,
        token: leg.token,
        lotsize: leg.lotsize,
        ltp, open: openV, high: highV, low: lowV, close: closeV, volume, oi,
      };
    };

    const rows = await Promise.all(slice.map(async (row) => ({
      strike: row.strike,
      ce: row.ce ? await legFor(row.ce) : null,
      pe: row.pe ? await legFor(row.pe) : null,
    })));

    const payload = {
      underlying,
      expiry,
      expiries,
      spot,
      lotSize: slice[0]?.ce?.lotsize || slice[0]?.pe?.lotsize || null,
      rows,
    };

    // How many legs actually came back with a price this build?
    const priced = rows.reduce(
      (n: number, r: any) => n + ((r.ce?.ltp > 0 ? 1 : 0) + (r.pe?.ltp > 0 ? 1 : 0)),
      0,
    );
    // Last-good chain (no spot in key so any recent good build is reusable).
    const goodKey = `opt:chainGood:${underlying}:${expiry}:${radius}`;

    if (priced > 0) {
      // Healthy build — cache short for burst collapse + 2 min as the
      // outage fallback.
      await cacheSet(chainKey, payload, 800);
      await cacheSet(goodKey, payload, 120_000);
      return res.json(payload);
    }

    // Broker returned nothing AND no per-token cache (cold start during an
    // Angel timeout) → don't show a wall of zeros. Serve the last good chain
    // (prices may be a touch stale) with a fresh spot, if we have one.
    const lastGood = await cacheGet<any>(goodKey);
    if (lastGood) {
      return res.json({ ...lastGood, spot, fromCache: true, stale: true });
    }
    // Genuinely nothing yet — return the (unpriced) strikes so the grid still
    // renders; the next 5 s poll fills prices once the broker responds.
    await cacheSet(chainKey, payload, 800);
    return res.json(payload);
  } catch (err: any) {
    console.error('[market] option-chain error:', err.message || err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

export default router;
