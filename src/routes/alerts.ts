/**
 * Alert CRUD endpoints.
 *
 *   GET    /api/alerts            — every alert for the user (any status)
 *   POST   /api/alerts            — create
 *   PATCH  /api/alerts/:id        — { status: 'active'|'paused' } or note/value/etc
 *   DELETE /api/alerts/:id        — soft-delete (just removes)
 *   GET    /api/alerts/events     — fired-events history (newest first)
 */
import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { Alert, AlertType, AlertFrequency, AlertStatus } from '../models/Alert';
import { AlertEvent } from '../models/AlertEvent';
import { fetchQuotes } from '../services/marketData';
import { seedPrice, invalidateAlertSymbolCache } from '../services/alertService';

const router = Router();

const VALID_TYPES: AlertType[] = ['above', 'below', 'pctUp', 'pctDown'];
const VALID_FREQ:  AlertFrequency[] = ['once', 'every', 'daily'];

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const status = req.query.status as AlertStatus | undefined;
  const filter: any = { userId: req.user!.userId };
  if (status) filter.status = status;
  const alerts = await Alert.find(filter).sort({ createdAt: -1 });
  res.json({ alerts });
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const {
    symbol,
    type,
    value,
    frequency = 'once',
    cooldownSeconds = 300,
    note = '',
  } = req.body || {};

  if (!symbol)                          return res.status(400).json({ error: 'symbol required' });
  if (!VALID_TYPES.includes(type))      return res.status(400).json({ error: 'invalid type' });
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
                                        return res.status(400).json({ error: 'value must be a positive number' });
  if (!VALID_FREQ.includes(frequency))  return res.status(400).json({ error: 'invalid frequency' });

  const upper = String(symbol).toUpperCase();

  // For percentage alerts, capture the current LTP as the baseline
  let baselinePrice: number | undefined;
  if (type === 'pctUp' || type === 'pctDown') {
    const quotes = await fetchQuotes([upper]);
    const q = quotes.find((x) => x.displaySymbol.toUpperCase() === upper);
    if (!q || !q.price) {
      return res.status(400).json({ error: `Could not fetch baseline price for ${upper}` });
    }
    baselinePrice = q.price;
    seedPrice(upper, q.price);
  } else {
    // For above/below also seed the prev-price so the FIRST cross is detected
    const quotes = await fetchQuotes([upper]);
    const q = quotes.find((x) => x.displaySymbol.toUpperCase() === upper);
    if (q?.price) seedPrice(upper, q.price);
  }

  const alert = await Alert.create({
    userId: new Types.ObjectId(req.user!.userId),
    symbol: upper,
    type,
    value,
    baselinePrice,
    frequency,
    cooldownSeconds: Math.max(30, Math.min(86400, Number(cooldownSeconds) || 300)),
    note: String(note).slice(0, 200),
  });
  invalidateAlertSymbolCache(); // arm the new alert on the very next tick

  res.status(201).json({ alert });
});

router.patch('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const allowed = ['status', 'value', 'note', 'frequency', 'cooldownSeconds'] as const;
  const update: any = {};
  for (const k of allowed) {
    if (req.body?.[k] !== undefined) update[k] = req.body[k];
  }
  if (update.status && !['active', 'paused', 'triggered'].includes(update.status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  // If the user reactivates a "triggered" once-alert, treat it as a fresh
  // alert — clear lastTriggeredAt so it can fire again.
  if (update.status === 'active') update.lastTriggeredAt = null;

  const alert = await Alert.findOneAndUpdate(
    { _id: req.params.id, userId: req.user!.userId },
    { $set: update },
    { new: true }
  );
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  invalidateAlertSymbolCache();
  res.json({ alert });
});

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const result = await Alert.deleteOne({ _id: req.params.id, userId: req.user!.userId });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
  invalidateAlertSymbolCache();
  res.json({ ok: true });
});

router.get('/events', requireAuth, async (req: AuthRequest, res: Response) => {
  const limit = Math.min(parseInt(String(req.query.limit || '50'), 10), 200);
  const events = await AlertEvent.find({ userId: req.user!.userId })
    .sort({ triggeredAt: -1 })
    .limit(limit);
  res.json({ events });
});

export default router;
