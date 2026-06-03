/**
 * Admin REST endpoints.
 *
 * All routes require:
 *  - Valid JWT (requireAuth)
 *  - role === 'admin' on the token (requireAdmin)
 *
 * Endpoints:
 *  GET    /api/admin/users                        — paged list of all users
 *  GET    /api/admin/users/:id                    — single-user details
 *  POST   /api/admin/users/:id/margin             — { amount } adds/subtracts virtualBalance
 *                                                   ledger entry written to MarginLedger
 *  GET    /api/admin/users/:id/ledger             — margin ledger history
 */
import { Router, Response } from 'express';
import { Types } from 'mongoose';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/auth';
import { User } from '../models/User';
import { MarginLedger } from '../models/MarginLedger';
import { recomputeAllBalances } from '../services/balanceRecompute';

const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/users', async (req: AuthRequest, res: Response) => {
  const search = String(req.query.q || '').trim();
  const filter: any = {};
  if (search) {
    filter.$or = [
      { email:    { $regex: search, $options: 'i' } },
      { username: { $regex: search, $options: 'i' } },
    ];
  }
  const users = await User.find(filter)
    .select('-password')
    .sort({ createdAt: -1 })
    .limit(200);
  res.json({
    users: users.map((u) => ({
      id: u._id.toString(),
      username: u.username,
      email: u.email,
      virtualBalance: u.virtualBalance,
      role: u.role,
      createdAt: u.createdAt,
    })),
  });
});

router.get('/users/:id', async (req: AuthRequest, res: Response) => {
  const u = await User.findById(req.params.id).select('-password');
  if (!u) return res.status(404).json({ error: 'User not found' });
  res.json({
    user: {
      id: u._id.toString(),
      username: u.username,
      email: u.email,
      virtualBalance: u.virtualBalance,
      role: u.role,
      createdAt: u.createdAt,
    },
  });
});

router.post('/users/:id/margin', async (req: AuthRequest, res: Response) => {
  const amount = Number(req.body?.amount);
  const note = String(req.body?.note || '').slice(0, 200);
  if (!Number.isFinite(amount) || amount === 0) {
    return res.status(400).json({ error: 'amount must be a non-zero number' });
  }

  const u = await User.findById(req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });

  const before = u.virtualBalance;
  const after = before + amount;
  if (after < 0) {
    return res.status(400).json({ error: 'Resulting balance would be negative' });
  }

  u.virtualBalance = after;
  await u.save();

  await MarginLedger.create({
    userId: u._id,
    adminId: new Types.ObjectId(req.user!.userId),
    amount,
    balanceBefore: before,
    balanceAfter: after,
    note,
  });

  res.json({
    ok: true,
    user: {
      id: u._id.toString(),
      username: u.username,
      email: u.email,
      virtualBalance: u.virtualBalance,
      role: u.role,
    },
  });
});

router.get('/users/:id/ledger', async (req: AuthRequest, res: Response) => {
  const entries = await MarginLedger.find({ userId: req.params.id })
    .sort({ createdAt: -1 })
    .limit(100)
    .populate('adminId', 'username email');
  res.json({ entries });
});

/**
 * One-time balance recompute (idempotent) for the cash-settled P&L
 * double-count + CNC phantom-margin fix.
 *   POST /api/admin/recompute-balances           — apply to all un-corrected users
 *   POST /api/admin/recompute-balances?dry=1      — preview only (no writes)
 */
router.post('/recompute-balances', async (req: AuthRequest, res: Response) => {
  const dryRun = req.query.dry === '1' || req.query.dry === 'true';
  const results = await recomputeAllBalances(dryRun);
  const applied = results.filter((r) => !r.skipped && (Math.abs(r.delta) > 0.005 || r.cncPositionsFixed > 0));
  res.json({
    dryRun,
    scanned: results.length,
    changed: applied.length,
    totalDelta: Math.round(applied.reduce((s, r) => s + r.delta, 0) * 100) / 100,
    results: applied,
  });
});

export default router;
