import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import {
  fetchHistory,
  fetchQuotes,
  fetchSnapshot,
  getLatestCached,
  toYahooSymbol,
  Period,
  searchSymbols,
} from '../services/marketData';
import { scripMaster } from '../services/scripMaster';
import { angel } from '../services/angelOne';
import { angelEnabled } from '../config/env';

const router = Router();

const PERIODS: Period[] = ['1D', '1W', '1M', '3M', '6M', '1Y', '3Y', '5Y', 'ALL'];

router.get('/history', requireAuth, async (req: AuthRequest, res: Response) => {
  const symbol = String(req.query.symbol || '');
  const periodRaw = String(req.query.period || '1D').toUpperCase() as Period;
  const period: Period = PERIODS.includes(periodRaw) ? periodRaw : '1D';
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const candles = await fetchHistory(symbol, period);
  res.json({ symbol, period, candles });
});

router.get('/search', requireAuth, async (req: AuthRequest, res: Response) => {
  const q = String(req.query.q || '');
  if (!q) return res.json({ results: [] });
  const results = await searchSymbols(q);
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

// Rich snapshot used by the stock-detail page
router.get('/snapshot/:symbol', requireAuth, async (req: AuthRequest, res: Response) => {
  const symbol = String(req.params.symbol || '');
  if (!symbol) return res.status(400).json({ error: 'symbol required' });
  const snap = await fetchSnapshot(symbol);
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

    // Spot price (drives ATM selection). We only need ONE number — the
    // current price — so the heavy FULL-mode snapshot is overkill here.
    // Cached → light OHLC quote → error. (FULL snapshot lives on the
    // stock-detail page where the 52w/circuit/OI/depth fields are read.)
    let spot = getLatestCached(toYahooSymbol(underlying))?.price ?? 0;
    if (!spot) {
      try {
        const qs = await fetchQuotes([underlying]);
        spot = qs[0]?.price ?? 0;
      } catch { /* fall through */ }
    }
    if (!spot) {
      return res.status(503).json({ error: 'Could not fetch spot price for ATM' });
    }

    const slice = scripMaster.getOptionChainSlice(underlying, expiry, spot, radius);

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
    const quotes = await angel.getQuotesByTokens(pairs, 'FULL');
    const byToken = new Map<string, any>(quotes.map((q: any) => [String(q.symbolToken), q]));

    const rows = slice.map((row) => ({
      strike: row.strike,
      ce: row.ce
        ? {
            symbol: row.ce.symbol,
            token: row.ce.token,
            lotsize: row.ce.lotsize,
            ltp:    Number(byToken.get(row.ce.token)?.ltp ?? 0),
            open:   Number(byToken.get(row.ce.token)?.open ?? 0),
            high:   Number(byToken.get(row.ce.token)?.high ?? 0),
            low:    Number(byToken.get(row.ce.token)?.low ?? 0),
            close:  Number(byToken.get(row.ce.token)?.close ?? 0),
            volume: Number(byToken.get(row.ce.token)?.tradeVolume ?? 0),
            oi:     Number(byToken.get(row.ce.token)?.opnInterest ?? 0),
          }
        : null,
      pe: row.pe
        ? {
            symbol: row.pe.symbol,
            token: row.pe.token,
            lotsize: row.pe.lotsize,
            ltp:    Number(byToken.get(row.pe.token)?.ltp ?? 0),
            open:   Number(byToken.get(row.pe.token)?.open ?? 0),
            high:   Number(byToken.get(row.pe.token)?.high ?? 0),
            low:    Number(byToken.get(row.pe.token)?.low ?? 0),
            close:  Number(byToken.get(row.pe.token)?.close ?? 0),
            volume: Number(byToken.get(row.pe.token)?.tradeVolume ?? 0),
            oi:     Number(byToken.get(row.pe.token)?.opnInterest ?? 0),
          }
        : null,
    }));

    res.json({
      underlying,
      expiry,
      expiries,
      spot,
      lotSize: slice[0]?.ce?.lotsize || slice[0]?.pe?.lotsize || null,
      rows,
    });
  } catch (err: any) {
    console.error('[market] option-chain error:', err.message || err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

export default router;
