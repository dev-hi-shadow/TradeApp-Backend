/**
 * One-time balance recompute (v1).
 *
 * Corrects wallets affected by two pre-fix accounting bugs:
 *
 *  1. P&L double-count on CASH-SETTLED instruments (all options + EQ CNC):
 *     the full notional already flowed through cashImpact on each leg, but the
 *     engine ALSO added realisedDelta to the wallet — counting P&L twice. The
 *     total erroneously-added amount equals Σ realisedPnL over cash-settled
 *     positions (the realisedPnL FIELD itself is correct; only the wallet was
 *     double-credited). → SUBTRACT it.
 *
 *  2. Phantom CNC margin: equity CNC blocked margin == full notional on top of
 *     paying full cash, so OPEN CNC positions still hold a bogus block that was
 *     subtracted from the wallet. → ADD it back, and zero the stored block.
 *     (Closed CNC positions already released their block, so net-zero — only
 *      currently-open CNC positions need correcting.)
 *
 * The correction is a DELTA (currentBalance + delta), so any admin top-ups or
 * resets are preserved. Idempotent via the user's `balanceRecalcV1` flag.
 */
import { Types } from 'mongoose';
import { User } from '../models/User';
import { Position } from '../models/Position';

const isOptionSym = (s: string) => /\d(?:CE|PE)$/.test(s.toUpperCase());

export interface RecomputeResult {
  userId: string;
  email: string;
  oldBalance: number;
  doubleCountedPnL: number;   // subtracted
  phantomCncMargin: number;   // added back
  delta: number;
  newBalance: number;
  cncPositionsFixed: number;
  skipped?: 'already-done';
}

/** Recompute a single user's balance. Pass dryRun to preview without writing. */
export async function recomputeUserBalance(
  userId: Types.ObjectId | string,
  dryRun = false,
): Promise<RecomputeResult | null> {
  const user = await User.findById(userId);
  if (!user) return null;

  const base: Omit<RecomputeResult, 'doubleCountedPnL' | 'phantomCncMargin' | 'delta' | 'newBalance' | 'cncPositionsFixed'> = {
    userId: user._id.toString(),
    email: user.email,
    oldBalance: user.virtualBalance,
  };

  if (user.balanceRecalcV1) {
    return { ...base, doubleCountedPnL: 0, phantomCncMargin: 0, delta: 0, newBalance: user.virtualBalance, cncPositionsFixed: 0, skipped: 'already-done' };
  }

  const positions = await Position.find({ userId: user._id });

  let doubleCountedPnL = 0;
  let phantomCncMargin = 0;
  const cncToZero: Types.ObjectId[] = [];

  for (const p of positions) {
    const cashSettled = isOptionSym(p.symbol) || p.product === 'CNC';
    if (cashSettled) doubleCountedPnL += p.realisedPnL || 0;
    // Phantom block only lingers on still-OPEN CNC positions.
    if (p.product === 'CNC' && p.netQuantity !== 0 && (p.marginBlocked || 0) > 0) {
      phantomCncMargin += p.marginBlocked || 0;
      cncToZero.push(p._id);
    }
  }

  const delta = round2(phantomCncMargin - doubleCountedPnL);
  const newBalance = round2(user.virtualBalance + delta);

  if (!dryRun) {
    // Atomic field update — avoids re-validating the whole user document
    // (legacy/odd docs with e.g. short passwords would otherwise fail save()).
    await User.updateOne(
      { _id: user._id },
      { $set: { virtualBalance: newBalance, balanceRecalcV1: true } },
    );
    if (cncToZero.length) {
      await Position.updateMany({ _id: { $in: cncToZero } }, { $set: { marginBlocked: 0 } });
    }
  }

  return {
    ...base,
    doubleCountedPnL: round2(doubleCountedPnL),
    phantomCncMargin: round2(phantomCncMargin),
    delta,
    newBalance,
    cncPositionsFixed: cncToZero.length,
  };
}

/** Recompute every not-yet-corrected user. */
export async function recomputeAllBalances(dryRun = false): Promise<RecomputeResult[]> {
  const filter = dryRun ? {} : { balanceRecalcV1: { $ne: true } };
  const users = await User.find(filter).select('_id');
  const out: RecomputeResult[] = [];
  for (const u of users) {
    try {
      const r = await recomputeUserBalance(u._id, dryRun);
      if (r) out.push(r);
    } catch (err: any) {
      // Never let one bad user doc abort the whole batch.
      console.error(`[recompute] user ${u._id} failed:`, err.message || err);
    }
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
