import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { TradingPlan } from '../models/TradingPlan';

const router = Router();
const MAX_PLANS_PER_USER = 20;

router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const plans = await TradingPlan.find({ userId: req.user!.userId }).sort({ createdAt: 1 });
  res.json({ plans });
});

router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, description, rules } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const count = await TradingPlan.countDocuments({ userId: req.user!.userId });
  if (count >= MAX_PLANS_PER_USER) {
    return res.status(400).json({ error: `Maximum ${MAX_PLANS_PER_USER} plans allowed` });
  }
  const plan = await TradingPlan.create({
    userId: new Types.ObjectId(req.user!.userId),
    name,
    description: description || '',
    rules: rules || {},
  });
  res.status(201).json({ plan });
});

router.put('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const { name, description, rules, status } = req.body || {};
  const plan = await TradingPlan.findOneAndUpdate(
    { _id: req.params.id, userId: req.user!.userId },
    { $set: { ...(name && { name }), ...(description !== undefined && { description }), ...(rules && { rules }), ...(status && { status }) } },
    { new: true }
  );
  if (!plan) return res.status(404).json({ error: 'Not found' });
  res.json({ plan });
});

router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const result = await TradingPlan.deleteOne({ _id: req.params.id, userId: req.user!.userId });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

export default router;
