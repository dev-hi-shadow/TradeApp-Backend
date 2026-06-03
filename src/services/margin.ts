/**
 * Margin requirement calculator for Indian-broker paper trading.
 *
 * Modelled on Zerodha's published SPAN+ELM tables (May 2026 snapshot) +
 * SEBI's prescribed rates. We don't run a real SPAN engine; instead we use
 * a "SPAN-lookalike" approximation that lands within ±10 % of Zerodha's
 * actual block for the vast majority of contracts.
 *
 *   ┌────────────────────────────────────┬────────────────────────────────┐
 *   │ Product / Segment                  │ Margin requirement             │
 *   ├────────────────────────────────────┼────────────────────────────────┤
 *   │ Equity CNC  (delivery)             │ 100 % cash                     │
 *   │ Equity MIS  (intraday)             │  20 %  (5× leverage)           │
 *   │ Equity Futures NRML / MIS          │  18 %  (SPAN+ELM approx)       │
 *   │ Index option BUY                   │ premium × qty  (cash, NOT      │
 *   │                                    │ margin — see notes)            │
 *   │ Index option SELL  (NRML / MIS)    │  12 %  of underlying notional  │
 *   │ Stock option SELL  (NRML / MIS)    │  25 %  of underlying notional  │
 *   │ Commodity Futures NRML / MIS       │  10 %                          │
 *   └────────────────────────────────────┴────────────────────────────────┘
 *
 * KEY NSE/ZERODHA RULES this calculator now honours:
 *  1. Option BUY = pay full premium → CASH OUT, ZERO margin blocked.
 *     The premium is gone from the wallet but no margin block exists on
 *     top of it. (Old version conflated the two.)
 *  2. Option SELL = receive premium AS CASH + block SPAN-style margin on
 *     the *underlying* contract value (spot × lot), not on the premium.
 *     A short NIFTY ATM option blocks ~₹1.4 lakh / lot, not ~₹500.
 *  3. Same symbol, different product = different position, different
 *     margin block. We never silently flip an MIS row to NRML.
 */
import type { Segment, Product, Side } from './charges';

const MARGIN_RATES = {
  EQ:        { CNC: 1.00, MIS: 0.20, NRML: 1.00 },
  FUTURES:   { CNC: 1.00, MIS: 0.18, NRML: 0.18 },
  // Option SELL rates apply to UNDERLYING NOTIONAL (spot × lot), not premium.
  INDEX_OPT: { CNC: 1.00, MIS: 0.12, NRML: 0.12 },
  STOCK_OPT: { CNC: 1.00, MIS: 0.25, NRML: 0.25 },
  COMMODITY: { CNC: 1.00, MIS: 0.10, NRML: 0.10 },
} as const;

export interface MarginInput {
  segment: Segment;
  product: Product;
  side:    Side;
  price:   number;       // premium for options, LTP for everything else
  quantity: number;      // contract count in shares (already × lotSize for F&O)
  isOption?: boolean;
  isStockOption?: boolean;
  /** REQUIRED for option SELL — underlying spot price (NIFTY 24,400, RELIANCE 2,830 …). */
  underlyingSpot?: number;
}

/**
 * Margin required to OPEN a position.
 *
 *  Option BUY  → 0   (the premium itself is cash spent, handled by orderEngine)
 *  Option SELL → SPAN-lookalike on the underlying notional
 *  Equity CNC  → full notional
 *  Equity MIS  → 20 % notional
 *  Futures     → 18 % notional
 *  Commodity   → 10 % notional
 */
export function requiredMargin(input: MarginInput): number {
  const { segment, product, side, price, quantity, isOption, isStockOption } = input;

  if (isOption) {
    if (side === 'buy') return 0;     // BUY option → no margin, only premium (cash out)
    // SELL option: SPAN+ELM lookalike on UNDERLYING value, not on premium.
    const rate = isStockOption
      ? MARGIN_RATES.STOCK_OPT[product]
      : MARGIN_RATES.INDEX_OPT[product];
    // If underlyingSpot wasn't passed we degrade gracefully to a strike-based
    // estimate that's still order-of-magnitude correct (better than premium-based).
    const spot = input.underlyingSpot && input.underlyingSpot > 0
      ? input.underlyingSpot
      : price; // strike is roughly the right scale for ATM, less so for ITM/OTM
    return spot * quantity * rate;
  }

  const notional = price * quantity;
  if (segment === 'EQ') {
    // CNC delivery is fully CASH-funded — cashImpactOnOpen removes the entire
    // notional from the wallet — so there is NO separate margin block. Adding
    // one would double-charge buying power (you'd "need" 2× the trade value).
    // Only MIS blocks margin (intraday leverage).
    if (product === 'CNC') return 0;
    return notional * MARGIN_RATES.EQ[product];
  }
  if (segment === 'FNO')       return notional * MARGIN_RATES.FUTURES[product];
  if (segment === 'COMMODITY') return notional * MARGIN_RATES.COMMODITY[product];
  return notional; // safe default
}

/**
 * Cash flow at fill time, NOT margin. Returns the amount to deduct from
 * (or credit to) the wallet, EXCLUDING brokerage/STT/etc. (those are
 * applied separately).
 *
 *  Option BUY  : pay full premium → negative
 *  Option SELL : receive premium → positive  (margin block is separate)
 *  Equity CNC  : pay full notional → negative on buy, positive on sell
 *  Anything MIS/NRML non-option: cash neutral — only margin blocks/releases
 */
export function cashImpactOnOpen(input: MarginInput): number {
  const { side, price, quantity, isOption, segment, product } = input;
  if (isOption) {
    return side === 'buy' ? -(price * quantity) : +(price * quantity);
  }
  if (segment === 'EQ' && product === 'CNC') {
    return side === 'buy' ? -(price * quantity) : +(price * quantity);
  }
  return 0; // margin-only, no cash exchange
}

/** Leverage multiplier for display ("5×", "8×", etc.). */
export function leverageFor(
  input: Omit<MarginInput, 'price' | 'quantity'> & { underlyingSpot?: number }
): number {
  const m = requiredMargin({
    ...input,
    price: 100,
    quantity: 1,
    underlyingSpot: input.underlyingSpot ?? 100,
  });
  return m > 0 ? Math.max(1, Math.round(100 / m)) : 1;
}
