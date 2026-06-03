/**
 * Trading-performance analytics — aggregates the Transaction ledger into the
 * numbers a paper trader learns from: daily P&L, a cumulative equity curve, and
 * headline stats (win rate, profit factor, max drawdown, best/worst day).
 *
 * All day-bucketing is in IST so it lines up with the trade history / calendar.
 */
import { Router, Response } from 'express';
import moment from 'moment-timezone';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { Transaction } from '../models/Transaction';
import { rangeFromQuery } from '../utils/istDate';

const IST = 'Asia/Kolkata';
const router = Router();

router.get('/performance', requireAuth, async (req: AuthRequest, res: Response) => {
  const range = rangeFromQuery(req.query); // {from,to} or null → all-time
  const filter: any = { userId: req.user!.userId };
  if (range) filter.timestamp = { $gte: new Date(range.from), $lt: new Date(range.to) };

  const txs = await Transaction.find(filter).sort({ timestamp: 1 });

  // ── Per-IST-day aggregation ──
  type Day = { date: string; realised: number; charges: number; trades: number; turnover: number };
  const dayMap = new Map<string, Day>();
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let closingTrades = 0;

  for (const t of txs) {
    const date = moment.tz(t.timestamp, IST).format('YYYY-MM-DD');
    let d = dayMap.get(date);
    if (!d) { d = { date, realised: 0, charges: 0, trades: 0, turnover: 0 }; dayMap.set(date, d); }
    const r = t.realisedPnL || 0;
    d.realised += r;
    d.charges += t.charges?.total || 0;
    d.trades += 1;
    d.turnover += (t.price || 0) * (t.quantity || 0);
    // A "closing trade" = a fill that booked P&L (reduce/close). Win = profit.
    if (r !== 0) {
      closingTrades++;
      if (r > 0) { wins++; grossProfit += r; } else { losses++; grossLoss += Math.abs(r); }
    }
  }

  const days = Array.from(dayMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((d) => ({ ...d, net: d.realised - d.charges }));

  // ── Equity curve (cumulative net) + peak-to-trough max drawdown ──
  let cum = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equityCurve = days.map((d) => {
    cum += d.net;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDrawdown) maxDrawdown = dd;
    return { date: d.date, cumulative: cum };
  });

  const sum = (sel: (d: typeof days[number]) => number) => days.reduce((s, d) => s + sel(d), 0);
  const totalRealised = sum((d) => d.realised);
  const totalCharges = sum((d) => d.charges);
  const best = days.reduce<typeof days[number] | null>((m, d) => (!m || d.net > m.net ? d : m), null);
  const worst = days.reduce<typeof days[number] | null>((m, d) => (!m || d.net < m.net ? d : m), null);

  res.json({
    days,
    equityCurve,
    stats: {
      netPnL: totalRealised - totalCharges,
      realisedPnL: totalRealised,
      charges: totalCharges,
      turnover: sum((d) => d.turnover),
      totalTrades: txs.length,
      closingTrades,
      wins,
      losses,
      winRate: closingTrades ? (wins / closingTrades) * 100 : 0,
      avgWin: wins ? grossProfit / wins : 0,
      avgLoss: losses ? -(grossLoss / losses) : 0,
      // null = no losses yet (avoid Infinity, which JSON drops to null anyway).
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      maxDrawdown,
      activeDays: days.length,
      bestDay: best ? { date: best.date, net: best.net } : null,
      worstDay: worst ? { date: worst.date, net: worst.net } : null,
    },
  });
});

export default router;
