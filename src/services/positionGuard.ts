/**
 * Position-guard evaluator — the auto-exit engine behind "SL on P&L".
 *
 * Runs on the price loop (once per symbol per tick). For every active guard it
 * checks the owning OPEN position against the stop-loss / target / trailing
 * levels and, when one is hit, squares the whole position off at market
 * (with slippage) — server-side, so it triggers even if the user is offline.
 *
 * Trailing maintenance: each tick we ratchet `trailAnchor` toward the best
 * price seen (high for longs, low for shorts) and persist only when it
 * actually advances, so a quiet position costs no writes.
 */
import { Order } from '../models/Order';
import { Position } from '../models/Position';
import { PositionGuard, IPositionGuard } from '../models/PositionGuard';
import { executeFill, marketFillPrice, FillResult } from './orderEngine';

export interface GuardEvent {
  userId: string;
  kind: 'triggered' | 'error';
  symbol: string;
  product: 'CNC' | 'MIS' | 'NRML';
  /** Which level fired: 'Stop-loss' | 'Target' | 'Trailing stop'. */
  reason: string;
  fill?: FillResult;
}

/** Distinct symbols with at least one guard — so the price loop prices them. */
export async function symbolsWithGuards(): Promise<string[]> {
  return PositionGuard.distinct('symbol');
}

function evaluate(
  guard: IPositionGuard,
  long: boolean,
  price: number,
): { reason: string | null; anchorChanged: boolean } {
  let anchorChanged = false;

  // Maintain the trailing anchor (best price since the stop was set).
  if (guard.trailingAmount && guard.trailingAmount > 0) {
    if (guard.trailAnchor == null) {
      guard.trailAnchor = price;
      anchorChanged = true;
    } else {
      const next = long ? Math.max(guard.trailAnchor, price) : Math.min(guard.trailAnchor, price);
      if (next !== guard.trailAnchor) {
        guard.trailAnchor = next;
        anchorChanged = true;
      }
    }
  }

  // Stop-loss (cap a loss).
  if (guard.stopLossPrice != null) {
    if ((long && price <= guard.stopLossPrice) || (!long && price >= guard.stopLossPrice)) {
      return { reason: 'Stop-loss', anchorChanged };
    }
  }
  // Target (book profit).
  if (guard.targetPrice != null) {
    if ((long && price >= guard.targetPrice) || (!long && price <= guard.targetPrice)) {
      return { reason: 'Target', anchorChanged };
    }
  }
  // Trailing stop (retrace from the best by trailingAmount).
  if (guard.trailingAmount && guard.trailingAmount > 0 && guard.trailAnchor != null) {
    const effSL = long ? guard.trailAnchor - guard.trailingAmount : guard.trailAnchor + guard.trailingAmount;
    if ((long && price <= effSL) || (!long && price >= effSL)) {
      return { reason: 'Trailing stop', anchorChanged };
    }
  }

  return { reason: null, anchorChanged };
}

export async function processPositionGuards(symbol: string, price: number): Promise<GuardEvent[]> {
  const sym = symbol.toUpperCase();
  const events: GuardEvent[] = [];
  if (!(price > 0)) return events;

  const guards = await PositionGuard.find({ symbol: sym });
  if (!guards.length) return events;

  for (const guard of guards) {
    try {
      const pos = await Position.findOne({
        userId: guard.userId,
        symbol: sym,
        product: guard.product,
        netQuantity: { $ne: 0 },
      });
      // Orphaned guard (position already closed) → drop it.
      if (!pos) {
        await PositionGuard.deleteOne({ _id: guard._id });
        continue;
      }

      const long = pos.netQuantity > 0;
      const { reason, anchorChanged } = evaluate(guard, long, price);

      if (!reason) {
        if (anchorChanged) await guard.save(); // persist only a real ratchet
        continue;
      }

      // ── Square off the ENTIRE position at market ──
      const side: 'buy' | 'sell' = long ? 'sell' : 'buy';
      const qty = Math.abs(pos.netQuantity);
      const order = await Order.create({
        userId: guard.userId,
        symbol: sym,
        type: 'market',
        side,
        quantity: qty,
        product: guard.product,
        status: 'filling',
      });
      const fill = await executeFill(order, await marketFillPrice(sym, side, qty, price));
      await PositionGuard.deleteOne({ _id: guard._id });

      console.log(`[guard] ${reason} hit for ${sym} ${guard.product} — squared off ${qty} @ ${fill.fillPrice}`);
      events.push({
        userId: guard.userId.toString(),
        kind: 'triggered',
        symbol: sym,
        product: guard.product,
        reason,
        fill,
      });
    } catch (err: any) {
      console.error(`[guard] ${sym} ${guard.product} eval failed:`, err.message || err);
      events.push({
        userId: guard.userId.toString(),
        kind: 'error',
        symbol: sym,
        product: guard.product,
        reason: err.message || 'guard error',
      });
    }
  }

  return events;
}
