import { Router, Request, Response } from 'express';
import { User } from '../models/User';
import { Watchlist } from '../models/Watchlist';
import { signToken } from '../utils/jwt';
import { seedDefaultPlansForUser } from '../services/plansSeeder';
import { env } from '../config/env';

const router = Router();

const DEFAULT_WATCHLIST = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK'];

router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, email, password } = req.body || {};
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email, password required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 chars' });
    }
    const existing = await User.findOne({ $or: [{ email: email.toLowerCase() }, { username }] });
    if (existing) return res.status(409).json({ error: 'User already exists' });

    const user = await User.create({
      username,
      email,
      password,
      virtualBalance: env.DEFAULT_BALANCE,
    });
    await Watchlist.create({ userId: user._id, symbols: DEFAULT_WATCHLIST });
    await seedDefaultPlansForUser(user._id);

    const token = signToken({ userId: user._id.toString(), username: user.username, role: user.role });
    res.status(201).json({
      token,
      user: {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        virtualBalance: user.virtualBalance,
        role: user.role,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { emailOrUsername, password } = req.body || {};
    if (!emailOrUsername || !password) {
      return res.status(400).json({ error: 'Credentials required' });
    }
    const user = await User.findOne({
      $or: [{ email: emailOrUsername.toLowerCase() }, { username: emailOrUsername }],
    });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken({ userId: user._id.toString(), username: user.username, role: user.role });
    res.json({
      token,
      user: {
        id: user._id.toString(),
        username: user.username,
        email: user.email,
        virtualBalance: user.virtualBalance,
        role: user.role,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

export default router;
