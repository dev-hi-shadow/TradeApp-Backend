/**
 * Named watchlists (CRUD). Additive to the legacy single Watchlist — the first
 * GET seeds a default group from it so existing users keep their symbols.
 */
import { Router, Response } from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { WatchlistGroup } from '../models/WatchlistGroup';
import { Watchlist } from '../models/Watchlist';

const router = Router();

const MAX_GROUPS = 15;
const MAX_SYMBOLS = 100;

const cleanName = (v: unknown): string => String(v ?? '').trim().slice(0, 40);
const cleanSymbols = (v: unknown): string[] =>
  Array.isArray(v)
    ? Array.from(new Set(v.map((s) => String(s).toUpperCase().trim()).filter(Boolean))).slice(0, MAX_SYMBOLS)
    : [];

/** List the user's watchlists (auto-seeding a default from the legacy list). */
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  let groups = await WatchlistGroup.find({ userId }).sort({ order: 1, createdAt: 1 });
  if (!groups.length) {
    const legacy = await Watchlist.findOne({ userId });
    const def = await WatchlistGroup.create({
      userId,
      name: 'My Watchlist',
      symbols: legacy?.symbols ?? [],
      order: 0,
    });
    groups = [def];
  }
  res.json({ watchlists: groups });
});

/** Create a new (empty) named watchlist. */
router.post('/', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const count = await WatchlistGroup.countDocuments({ userId });
  if (count >= MAX_GROUPS) {
    return res.status(400).json({ error: `Maximum ${MAX_GROUPS} watchlists` });
  }
  const name = cleanName(req.body?.name) || `Watchlist ${count + 1}`;
  const group = await WatchlistGroup.create({ userId, name, symbols: cleanSymbols(req.body?.symbols), order: count });
  res.status(201).json({ watchlist: group });
});

/** Rename and/or replace the symbols of a watchlist. */
router.patch('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const group = await WatchlistGroup.findOne({ _id: req.params.id, userId: req.user!.userId });
  if (!group) return res.status(404).json({ error: 'Watchlist not found' });
  if (req.body?.name != null) {
    const n = cleanName(req.body.name);
    if (n) group.name = n;
  }
  if (req.body?.symbols != null) group.symbols = cleanSymbols(req.body.symbols);
  await group.save();
  res.json({ watchlist: group });
});

/** Delete a watchlist (never the last one). */
router.delete('/:id', requireAuth, async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const count = await WatchlistGroup.countDocuments({ userId });
  if (count <= 1) return res.status(400).json({ error: 'Keep at least one watchlist' });
  const r = await WatchlistGroup.deleteOne({ _id: req.params.id, userId });
  if (!r.deletedCount) return res.status(404).json({ error: 'Watchlist not found' });
  res.json({ ok: true });
});

export default router;
