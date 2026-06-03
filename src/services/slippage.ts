/**
 * Execution slippage model for market(-ish) fills.
 *
 * Real fills are never exactly at the last traded price (LTP):
 *   • You cross the bid/ask SPREAD — a buy lifts the ask, a sell hits the bid.
 *   • Large orders cause MARKET IMPACT — they walk up/down the order book.
 *
 * Our `Quote` only carries LTP (no live depth on the hot path), so we model
 * both effects SYNTHETICALLY with segment-calibrated parameters. This keeps
 * fills realistic and deterministic without adding an extra Angel depth call
 * on every order. If a caller has a depth snapshot it can pass best bid/ask to
 * pin the spread leg exactly; the impact leg stays synthetic.
 *
 * The adverse move is always AGAINST the taker:
 *   buy  fill = ltp × (1 + move)
 *   sell fill = ltp × (1 − move)   where move = halfSpread% + impact%
 *
 * All percentages are bounded so a fat-finger size can't produce an absurd
 * fill in the simulator.
 */
import type { Segment } from './charges';

export type SlippageClass = 'EQ' | 'FNO_FUT' | 'OPTION' | 'COMMODITY' | 'CURRENCY';

/** Full bid/ask spread as a fraction of price (we apply half to each side). */
const SPREAD_PCT: Record<SlippageClass, number> = {
  EQ: 0.0004, // ~4 bps full spread on a liquid large-cap
  FNO_FUT: 0.0006,
  OPTION: 0.006, // options books are wide — ~60 bps
  COMMODITY: 0.0005,
  CURRENCY: 0.0002,
};

/** Notional that incurs `IMPACT_PER_REF` of price impact (size sensitivity). */
const IMPACT_REF_NOTIONAL: Record<SlippageClass, number> = {
  EQ: 750_000,
  FNO_FUT: 3_000_000,
  OPTION: 300_000,
  COMMODITY: 1_500_000,
  CURRENCY: 2_000_000,
};
const IMPACT_PER_REF: Record<SlippageClass, number> = {
  EQ: 0.0006,
  FNO_FUT: 0.0006,
  OPTION: 0.004,
  COMMODITY: 0.0006,
  CURRENCY: 0.0003,
};
/** Hard cap on total adverse move (spread + impact), per class. */
const MAX_MOVE_PCT: Record<SlippageClass, number> = {
  EQ: 0.02,
  FNO_FUT: 0.02,
  OPTION: 0.08,
  COMMODITY: 0.02,
  CURRENCY: 0.01,
};

export function slippageClassOf(segment: Segment, isOption?: boolean, isFuture?: boolean): SlippageClass {
  if (segment === 'FNO') return isOption ? 'OPTION' : 'FNO_FUT';
  if (segment === 'COMMODITY') return 'COMMODITY';
  if (segment === 'CURRENCY') return 'CURRENCY';
  return 'EQ';
}

export interface SlippageInput {
  side: 'buy' | 'sell';
  quantity: number;
  ltp: number;
  segment: Segment;
  isOption?: boolean;
  isFuture?: boolean;
  /** Optional exact top-of-book; when present the spread leg uses it directly. */
  bestBid?: number;
  bestAsk?: number;
}

export interface SlippageResult {
  /** Effective fill price after spread + impact. */
  fillPrice: number;
  /** Total adverse move applied, as a fraction of LTP (e.g. 0.0012 = 0.12%). */
  movePct: number;
  /** Rupee slippage per unit vs LTP (always ≥ 0). */
  perUnit: number;
  klass: SlippageClass;
}

export function applySlippage(input: SlippageInput): SlippageResult {
  const { side, quantity, ltp, segment } = input;
  const klass = slippageClassOf(segment, input.isOption, input.isFuture);

  if (!Number.isFinite(ltp) || ltp <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
    return { fillPrice: ltp, movePct: 0, perUnit: 0, klass };
  }

  // ── Spread leg ──
  let halfSpreadPct: number;
  if (input.bestBid != null && input.bestAsk != null && input.bestAsk > input.bestBid && input.bestBid > 0) {
    // Exact: half the quoted spread relative to the mid.
    const mid = (input.bestBid + input.bestAsk) / 2;
    halfSpreadPct = mid > 0 ? (input.bestAsk - input.bestBid) / 2 / mid : SPREAD_PCT[klass] / 2;
  } else {
    halfSpreadPct = SPREAD_PCT[klass] / 2;
  }

  // ── Impact leg (size-dependent, gentle, capped) ──
  const notional = ltp * quantity;
  const impactPct = IMPACT_PER_REF[klass] * (notional / IMPACT_REF_NOTIONAL[klass]);

  const movePct = Math.min(MAX_MOVE_PCT[klass], halfSpreadPct + impactPct);
  const signed = side === 'buy' ? 1 : -1;
  const fillPrice = round2(ltp * (1 + signed * movePct));
  const perUnit = Math.abs(round2(fillPrice - ltp));

  return { fillPrice, movePct, perUnit, klass };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/* ───────────────────────── Real order-book walking ───────────────────────── */

export interface BookLevel { price: number; quantity: number }

export interface BookWalkResult {
  /** Volume-weighted fill price across the consumed levels (+ synthetic tail). */
  fillPrice: number;
  /** Quantity actually available in the visible book (real volume consumed). */
  bookQty: number;
  /** True if the order exceeded the visible book and a synthetic tail was used. */
  exhausted: boolean;
}

/**
 * Walk a REAL order book to price a market(-able) order against actual
 * available volume.
 *
 *   • buy  → walk the ask side (`sell` levels), lifting offers cheapest-first.
 *   • sell → walk the bid side (`buy` levels), hitting bids highest-first.
 *
 * Each level contributes `min(remaining, level.quantity)` at its price. If the
 * order is larger than the visible 5 levels (we only see 5), the remainder is
 * priced with the SYNTHETIC model anchored at the last (worst) visible level —
 * a stand-in for the deeper, unseen book. The returned price is the blended
 * VWAP over the whole order.
 *
 * With an empty book it degrades fully to the synthetic spread+impact model,
 * so nothing breaks for symbols without depth (Yahoo fallbacks, FULL-mode-off).
 */
/**
 * Sanity band around LTP. Depth levels outside this band are treated as
 * garbage (wrong instrument / scaling glitch / stale wide quote) and dropped,
 * and the final fill price is hard-clamped to it. This is a safety net: a real
 * market fill should never land outside this range, and it prevents a bad
 * upstream depth payload from ever producing an absurd fill (e.g. a ₹319
 * option "filling" at ₹140,979).
 */
const SANE_BAND: Record<SlippageClass, number> = {
  EQ: 0.2,
  FNO_FUT: 0.25,
  OPTION: 0.6,
  COMMODITY: 0.2,
  CURRENCY: 0.1,
};

export function walkBook(
  side: 'buy' | 'sell',
  quantity: number,
  ltp: number,
  levels: BookLevel[],
  segment: Segment,
  isOption?: boolean,
  isFuture?: boolean,
): BookWalkResult {
  if (!(ltp > 0) || !(quantity > 0)) {
    return { fillPrice: ltp, bookQty: 0, exhausted: true };
  }
  const klass = slippageClassOf(segment, isOption, isFuture);
  const band = SANE_BAND[klass];
  const lo = ltp * (1 - band);
  const hi = ltp * (1 + band);
  const clamp = (p: number) => Math.min(hi, Math.max(lo, p));

  // Drop garbage levels (wrong instrument / scale) before walking.
  const clean = (levels || []).filter((l) => l.price >= lo && l.price <= hi && l.quantity > 0);

  // No usable book → pure synthetic.
  if (clean.length === 0) {
    const s = applySlippage({ side, quantity, ltp, segment, isOption, isFuture });
    return { fillPrice: clamp(s.fillPrice), bookQty: 0, exhausted: true };
  }
  levels = clean;

  let remaining = quantity;
  let cost = 0;
  let lastPrice = levels[0].price;
  for (const lvl of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.quantity);
    cost += take * lvl.price;
    remaining -= take;
    lastPrice = lvl.price;
  }
  const bookQty = quantity - remaining;

  let exhausted = false;
  if (remaining > 0) {
    // Beyond the visible book → synthetic continuation anchored at the worst
    // seen level, scaled by the leftover size.
    exhausted = true;
    const tail = applySlippage({ side, quantity: remaining, ltp: lastPrice, segment, isOption, isFuture });
    cost += remaining * tail.fillPrice;
  }

  return { fillPrice: round2(clamp(cost / quantity)), bookQty, exhausted };
}

/** VWAP of consuming exactly `quantity` across already-acceptable levels.
 *  Assumes quantity ≤ Σ level.quantity (caller caps it). Best-first ordering. */
export function vwapOfLevels(levels: BookLevel[], quantity: number): number {
  let remaining = quantity;
  let cost = 0;
  for (const lvl of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lvl.quantity);
    cost += take * lvl.price;
    remaining -= take;
  }
  const filled = quantity - remaining;
  return filled > 0 ? round2(cost / filled) : 0;
}

/** Total quantity available across a set of levels. */
export function availableQty(levels: BookLevel[]): number {
  return levels.reduce((s, l) => s + (l.quantity > 0 ? l.quantity : 0), 0);
}
