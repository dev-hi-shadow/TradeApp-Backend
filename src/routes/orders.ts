import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { Order } from '../models/Order';
import { Position } from '../models/Position';
import { PositionGuard } from '../models/PositionGuard';
import { Transaction } from '../models/Transaction';
import { previewCharges, previewMarginBlock, lookupLotSize, closePositions, quoteMarketFill, convertPosition } from '../services/orderEngine';
import { User } from '../models/User';
import { fetchQuotes, getLatestCached, toYahooSymbol, fetchDepthQuote } from '../services/marketData';
import { rangeFromQuery, istDayRange } from '../utils/istDate';

const router = Router();

router.get('/charges/preview', requireAuth, async (req: AuthRequest, res: Response) => {
  const symbol   = String(req.query.symbol   || '');
  const side     = (String(req.query.side    || 'buy').toLowerCase() as 'buy' | 'sell');
  const product  = (String(req.query.product || 'CNC').toUpperCase() as 'CNC' | 'MIS' | 'NRML');
  const price    = parseFloat(String(req.query.price    || '0'));
  const quantity = parseInt(  String(req.query.quantity || '0'), 10) || 1;
  if (!symbol) {
    return res.status(400).json({ error: 'symbol required' });
  }
  // Warm the depth cache for THIS contract so (a) the estimated fill below is
  // computed off the REAL order book and (b) the cache is hot when the user
  // clicks Buy/Sell (the cache-only fill path then walks the real book).
  // Awaited — the preview is NOT the latency-sensitive fill path; degrades to
  // the synthetic model if depth is unavailable (Angel off / cold symbol).
  const depthQuote = await fetchDepthQuote(symbol).catch(() => null);
  // Price is optional — when 0 we still return lotSize + available margin so
  // the order modal can render correctly while it's waiting for the first
  // live tick on the contract.
  // Always try to resolve the live LTP — frontend uses this to seed the
  // order modal so the user sees a price the instant the modal opens,
  // without having to wait for the next WS tick. Cheap when cached.
  let ltp = getLatestCached(toYahooSymbol(symbol))?.price ?? 0;
  if (!ltp) {
    try {
      const qs = await fetchQuotes([symbol]);
      ltp = qs[0]?.price ?? 0;
    } catch { /* fall through with 0 */ }
  }
  // Option contracts aren't on Yahoo and may not be cached yet; the depth
  // quote above (Angel FULL via scrip master) carries the real LTP — use it
  // so the modal shows a price for any tradable option from the chain.
  if (!ltp && depthQuote?.ltp) ltp = depthQuote.ltp;
  const refPriceForCalc = price > 0 ? price : ltp;

  const breakup = refPriceForCalc > 0
    ? previewCharges(symbol, side, refPriceForCalc, quantity, product)
    : { brokerage: 0, stt: 0, exchangeTxn: 0, sebi: 0, stampDuty: 0, dpCharges: 0, gst: 0, total: 0, notes: [] };
  const margin = refPriceForCalc > 0
    ? await previewMarginBlock(symbol, side, refPriceForCalc, quantity, product)
    : { marginBlocked: 0, cashImpact: 0, underlyingSpot: 0 };
  const lotSize = lookupLotSize(symbol);

  // Available margin = wallet − unrealised loss on open positions.
  const [user, positions] = await Promise.all([
    User.findById(req.user!.userId),
    Position.find({ userId: req.user!.userId }),
  ]);
  let unrealised = 0;
  let marginUsed = 0;
  for (const p of positions) {
    if (p.netQuantity === 0) continue;
    marginUsed += p.marginBlocked || 0;
    // Use entry price as proxy if no live quote — preview only.
    // The real live-tick portfolio push covers the moving number.
    unrealised += 0;
  }
  const balance = user?.virtualBalance ?? 0;
  const availableMargin = Math.max(0, balance - Math.max(0, -unrealised));

  // Estimated MARKET fill — walks the real cached order book (volume-based),
  // so the modal can show what the user will ACTUALLY fill at vs the raw LTP.
  // For limit orders the frontend shows the typed limit instead; this estimate
  // is meaningful for market/SL-M entries and exits.
  const est = ltp > 0 && quantity > 0 ? quoteMarketFill(symbol, side, quantity, ltp) : null;

  res.json({
    charges: breakup,
    turnover: refPriceForCalc * quantity,
    margin,
    lotSize: lotSize > 0 ? lotSize : null,
    available: { balance, marginUsed, availableMargin },
    ltp,
    estFill: est ? est.fillPrice : null,
    estFillMode: est ? est.mode : null,
    estFillBookQty: est ? est.bookQty : 0,
  });
});

router.get('/orders', requireAuth, async (req: AuthRequest, res: Response) => {
  const status = req.query.status as string | undefined;
  const limit = Math.min(parseInt(String(req.query.limit || '100'), 10), 500);
  const filter: any = { userId: req.user!.userId };
  if (status) filter.status = status;
  // Optional IST date filter: ?date=YYYY-MM-DD (one IST day) or ?from=&to= (ms).
  const range = rangeFromQuery(req.query);
  if (range) filter.createdAt = { $gte: new Date(range.from), $lt: new Date(range.to) };
  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(limit);
  res.json({ orders });
});

/**
 * Per-day (or per-range) trade summary from the Transaction ledger — powers the
 * "Today's trades / P&L" strip and the date-filtered History on the Trade page.
 * ?date=YYYY-MM-DD (IST day, default today) or ?from=&to= (epoch ms).
 */
router.get('/trades/summary', requireAuth, async (req: AuthRequest, res: Response) => {
  const r = rangeFromQuery(req.query) ?? istDayRange();
  const txs = await Transaction.find({
    userId: req.user!.userId,
    timestamp: { $gte: new Date(r.from), $lt: new Date(r.to) },
  }).sort({ timestamp: -1 });

  let buys = 0, sells = 0, turnover = 0, charges = 0, realisedPnL = 0;
  for (const t of txs) {
    if (t.side === 'buy') buys++; else sells++;
    turnover += (t.price || 0) * (t.quantity || 0);
    charges += t.charges?.total || 0;
    realisedPnL += t.realisedPnL || 0;
  }
  res.json({
    count: txs.length,
    buys,
    sells,
    turnover,
    charges,
    realisedPnL,
    from: r.from,
    to: r.to,
  });
});

router.get('/positions', requireAuth, async (req: AuthRequest, res: Response) => {
  const positions = await Position.find({ userId: req.user!.userId });
  res.json({ positions });
});

/**
 * Convert an open position's product (MIS↔CNC equity, MIS↔NRML F&O).
 * Re-blocks margin + adjusts the wallet for the change in committed capital.
 */
router.post('/positions/:symbol/convert', requireAuth, async (req: AuthRequest, res: Response) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const toProduct = String(req.body?.toProduct || '').toUpperCase();
  const fromProduct = req.body?.fromProduct ? String(req.body.fromProduct).toUpperCase() : undefined;
  if (!['CNC', 'MIS', 'NRML'].includes(toProduct)) {
    return res.status(400).json({ ok: false, error: 'Invalid target product' });
  }
  const r = await convertPosition(
    req.user!.userId,
    symbol,
    toProduct as 'CNC' | 'MIS' | 'NRML',
    fromProduct as 'CNC' | 'MIS' | 'NRML' | undefined,
  );
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

/**
 * Close a single open position at market (LTP). Flips side: long → sell, short → buy.
 * Creates a market order, fills it, returns the updated wallet + snapshot.
 */
router.post('/positions/:symbol/exit', requireAuth, async (req: AuthRequest, res: Response) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const product = req.query.product
    ? (String(req.query.product).toUpperCase() as 'CNC' | 'MIS' | 'NRML')
    : undefined;
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  const { results } = await closePositions(req.user!.userId, { symbol, product });
  if (!results.length) return res.status(404).json({ error: 'No open position for symbol' });
  res.json({ results });
});

/**
 * Close every open position for the user at market. Best-effort: collects
 * per-symbol results and never short-circuits on a single failure.
 */
router.post('/positions/exit-all', requireAuth, async (req: AuthRequest, res: Response) => {
  const { results } = await closePositions(req.user!.userId);
  if (!results.length) return res.json({ results: [], message: 'No open positions' });
  res.json({ results });
});

/* ───────────── Position guards (SL / Target / Trailing auto-exit) ───────────── */

/** List all active guards for the user. */
router.get('/positions/guards', requireAuth, async (req: AuthRequest, res: Response) => {
  const guards = await PositionGuard.find({ userId: req.user!.userId });
  res.json({ guards });
});

/** Coerce a body value to a positive number, or undefined to CLEAR the level. */
function levelOrClear(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Set / update the guard for a position. Body:
 *   { product?, stopLossPrice?, targetPrice?, trailingAmount? }
 * A field that is null / 0 / omitted is CLEARED. If all three end up empty the
 * guard is deleted. Requires a matching OPEN position.
 */
router.put('/positions/:symbol/guard', requireAuth, async (req: AuthRequest, res: Response) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'symbol required' });

  // Resolve product: explicit body wins, else infer from the (single) open position.
  let product = req.body?.product
    ? (String(req.body.product).toUpperCase() as 'CNC' | 'MIS' | 'NRML')
    : undefined;
  const openPositions = await Position.find({
    userId: req.user!.userId,
    symbol,
    netQuantity: { $ne: 0 },
  });
  if (!openPositions.length) return res.status(404).json({ error: 'No open position to guard' });
  if (!product) {
    if (openPositions.length > 1) {
      return res.status(400).json({ error: 'Multiple products open — specify product' });
    }
    product = openPositions[0].product;
  }
  const pos = openPositions.find((p) => p.product === product);
  if (!pos) return res.status(404).json({ error: `No open ${product} position for ${symbol}` });

  const stopLossPrice = levelOrClear(req.body?.stopLossPrice);
  const targetPrice = levelOrClear(req.body?.targetPrice);
  const trailingAmount = levelOrClear(req.body?.trailingAmount);

  // Nothing set → remove any existing guard.
  if (stopLossPrice == null && targetPrice == null && trailingAmount == null) {
    await PositionGuard.deleteOne({ userId: req.user!.userId, symbol, product });
    return res.json({ guard: null, cleared: true });
  }

  // Reset the trailing anchor to the current LTP whenever a trailing stop is
  // (re)armed, so it starts ratcheting from now — not a stale prior anchor.
  let trailAnchor: number | undefined;
  if (trailingAmount != null) {
    const cachedPx = getLatestCached(toYahooSymbol(symbol))?.price;
    trailAnchor = cachedPx && cachedPx > 0 ? cachedPx : pos.avgEntryPrice;
  }

  const guard = await PositionGuard.findOneAndUpdate(
    { userId: req.user!.userId, symbol, product },
    {
      $set: { stopLossPrice, targetPrice, trailingAmount, trailAnchor },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  res.json({ guard });
});

/** Clear the guard for a position. */
router.delete('/positions/:symbol/guard', requireAuth, async (req: AuthRequest, res: Response) => {
  const symbol = String(req.params.symbol || '').toUpperCase();
  const filter: any = { userId: req.user!.userId, symbol };
  if (req.query.product) filter.product = String(req.query.product).toUpperCase();
  await PositionGuard.deleteMany(filter);
  res.json({ ok: true });
});

router.get('/transactions', requireAuth, async (req: AuthRequest, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit || '100'), 10), 500);
  const txs = await Transaction.find({ userId: req.user!.userId })
    .sort({ timestamp: -1 })
    .limit(limit);
  res.json({ transactions: txs });
});

export default router;
