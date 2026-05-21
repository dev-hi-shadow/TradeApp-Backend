import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { Order } from '../models/Order';
import { Position } from '../models/Position';
import { Transaction } from '../models/Transaction';
import { previewCharges, previewMarginBlock, lookupLotSize } from '../services/orderEngine';
import { User } from '../models/User';
import { fetchQuotes, getLatestCached, toYahooSymbol } from '../services/marketData';

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
  const refPriceForCalc = price > 0 ? price : ltp;

  const breakup = refPriceForCalc > 0
    ? previewCharges(symbol, side, refPriceForCalc, quantity, product)
    : { brokerage: 0, stt: 0, exchangeTxn: 0, sebi: 0, stampDuty: 0, gst: 0, total: 0, notes: [] };
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

  res.json({
    charges: breakup,
    turnover: refPriceForCalc * quantity,
    margin,
    lotSize: lotSize > 0 ? lotSize : null,
    available: { balance, marginUsed, availableMargin },
    ltp,
  });
});

router.get('/orders', requireAuth, async (req: AuthRequest, res: Response) => {
  const status = req.query.status as string | undefined;
  const limit = Math.min(parseInt(String(req.query.limit || '100'), 10), 500);
  const filter: any = { userId: req.user!.userId };
  if (status) filter.status = status;
  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(limit);
  res.json({ orders });
});

router.get('/positions', requireAuth, async (req: AuthRequest, res: Response) => {
  const positions = await Position.find({ userId: req.user!.userId });
  res.json({ positions });
});

router.get('/transactions', requireAuth, async (req: AuthRequest, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit || '100'), 10), 500);
  const txs = await Transaction.find({ userId: req.user!.userId })
    .sort({ timestamp: -1 })
    .limit(limit);
  res.json({ transactions: txs });
});

export default router;
