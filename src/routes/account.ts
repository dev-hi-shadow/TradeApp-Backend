import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { User } from '../models/User';
import { Order } from '../models/Order';
import { Position } from '../models/Position';
import { PositionGuard } from '../models/PositionGuard';
import { Transaction } from '../models/Transaction';
import { Watchlist } from '../models/Watchlist';
import { env } from '../config/env';

const router = Router();

router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  const user = await User.findById(req.user!.userId).select('-password');
  if (!user) return res.status(404).json({ error: 'Not found' });
  const watchlist = await Watchlist.findOne({ userId: user._id });
  res.json({
    user: {
      id: user._id.toString(),
      username: user.username,
      email: user.email,
      virtualBalance: user.virtualBalance,
      role: user.role,
      createdAt: user.createdAt,
      avatarUrl: user.avatarUrl,
      emailVerified: user.emailVerified,
      authProvider: user.googleId ? 'google' : 'local',
    },
    watchlist: watchlist?.symbols || [],
  });
});

router.get('/watchlist', requireAuth, async (req: AuthRequest, res: Response) => {
  const wl = await Watchlist.findOne({ userId: req.user!.userId });
  res.json({ symbols: wl?.symbols || [] });
});

const LOCKED_WATCHLIST_SYMBOLS = ['NIFTY', 'SENSEX', 'BANKNIFTY', 'GOLD', 'SILVER', 'CRUDEOIL'];

router.put('/watchlist', requireAuth, async (req: AuthRequest, res: Response) => {
  const symbols: string[] = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
  const cleaned = Array.from(
    new Set(symbols.map((s) => String(s).toUpperCase().trim()).filter(Boolean))
  );
  for (const s of LOCKED_WATCHLIST_SYMBOLS) {
    if (!cleaned.includes(s)) cleaned.unshift(s);
  }
  const wl = await Watchlist.findOneAndUpdate(
    { userId: req.user!.userId },
    { symbols: cleaned },
    { upsert: true, new: true }
  );
  res.json({ symbols: wl.symbols });
});

router.post('/reset', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  await Promise.all([
    Order.deleteMany({ userId }),
    Position.deleteMany({ userId }),
    Transaction.deleteMany({ userId }),
    PositionGuard.deleteMany({ userId }),
  ]);
  await User.updateOne({ _id: userId }, { $set: { virtualBalance: env.DEFAULT_BALANCE } });
  res.json({ ok: true, virtualBalance: env.DEFAULT_BALANCE });
});

export default router;
