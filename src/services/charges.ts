/**
 * Indian-broker accurate trade-charges calculator.
 *
 * Modelled on Zerodha/Groww/Upstox public schedule.  All rates verified
 * against SEBI/NSE/BSE/MCX circulars and Zerodha's "Brokerage calculator".
 *
 * Components per fill:
 *   • Brokerage     — broker's fee per executed order
 *   • STT / CTT     — Securities / Commodities Transaction Tax
 *   • Exchange txn  — NSE/BSE/MCX transaction charges
 *   • SEBI          — SEBI turnover fee (₹10/crore = 0.0001%)
 *   • Stamp duty    — paid by the BUYER only
 *   • GST           — 18 % of (brokerage + exchange + SEBI)
 *
 * Total = sum of the above. Subtract from balance on fill.
 *
 * Reference (May 2026):
 *  https://zerodha.com/charges/
 *  https://www.sebi.gov.in/sebi_data/circulars  (transaction charge schedules)
 */

export type Segment = 'EQ' | 'FNO' | 'COMMODITY' | 'CURRENCY';
export type Product = 'CNC' | 'MIS' | 'NRML';
export type Side    = 'buy' | 'sell';

export interface ChargeBreakup {
  brokerage:     number;
  stt:           number;
  exchangeTxn:   number;
  sebi:          number;
  stampDuty:     number;
  /** Depository (DP) charge — flat per-scrip fee on equity DELIVERY sells. */
  dpCharges:     number;
  gst:           number;
  total:         number;
  /** Free-form description for UI tooltip / order receipt. */
  notes:         string[];
}

// Depository Participant charge: a flat per-scrip-per-day fee the CDSL/NSDL +
// broker levy when shares LEAVE your demat (i.e. equity delivery SELL only).
// Zerodha: ₹13.5 + GST, independent of quantity. Buys, intraday, and F&O have
// no DP charge.
const DP_CHARGE_FLAT = 13.5;

export interface ChargeInput {
  segment:   Segment;
  product:   Product;
  side:      Side;
  price:     number;
  quantity:  number;
  /** True if this is an options contract — drives the per-order ₹20 brokerage and the on-premium STT. */
  isOption?: boolean;
  /** Specifically a stock option (vs index option) — affects STT bucket. */
  isStockOption?: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeCharges(input: ChargeInput): ChargeBreakup {
  const { segment, product, side, price, quantity } = input;
  const turnover = price * quantity;
  const notes: string[] = [];

  // ---------- 1. Brokerage ----------
  let brokerage = 0;
  if (segment === 'EQ' && product === 'CNC') {
    brokerage = 0; // zero-brokerage delivery (Zerodha/Groww standard)
    notes.push('Brokerage ₹0 (Equity Delivery)');
  } else if (input.isOption) {
    brokerage = 20; // flat ₹20 per executed order on options
    notes.push('Brokerage flat ₹20 (Options)');
  } else {
    brokerage = Math.min(20, turnover * 0.0003); // 0.03 % capped at ₹20
    notes.push(`Brokerage ${(brokerage === 20 ? '₹20 cap' : '0.03 %')}`);
  }

  // ---------- 2. STT / CTT ----------
  let stt = 0;
  if (segment === 'EQ' && product === 'CNC') {
    stt = turnover * 0.001;          // 0.10 % both buy & sell
  } else if (segment === 'EQ' && product === 'MIS') {
    if (side === 'sell') stt = turnover * 0.00025; // 0.025 % sell side
  } else if (segment === 'FNO' && !input.isOption) {
    if (side === 'sell') stt = turnover * 0.0002;  // 0.02 % sell side (futures)
  } else if (segment === 'FNO' && input.isOption) {
    if (side === 'sell') stt = turnover * 0.001;   // 0.1 % sell side on premium
  } else if (segment === 'COMMODITY') {
    if (side === 'sell') stt = turnover * 0.0001;  // 0.01 % CTT sell side (non-agri)
  }

  // ---------- 3. Exchange transaction charge ----------
  let exchangeTxn = 0;
  if (segment === 'EQ') {
    exchangeTxn = turnover * 0.0000297; // 0.00297 % (NSE)
  } else if (segment === 'FNO' && !input.isOption) {
    exchangeTxn = turnover * 0.000019;  // 0.0019 % futures
  } else if (segment === 'FNO' && input.isOption) {
    exchangeTxn = turnover * 0.00035;   // 0.035 % on premium
  } else if (segment === 'COMMODITY') {
    exchangeTxn = turnover * 0.000026;  // 0.0026 % MCX (varies by contract)
  } else if (segment === 'CURRENCY') {
    exchangeTxn = turnover * 0.0000035; // approx 0.00035 % options / much lower for futures
  }

  // ---------- 4. SEBI turnover fee ----------
  const sebi = turnover * 0.000001;     // ₹10 per crore = 0.0001 %

  // ---------- 5. Stamp duty (BUY side only) ----------
  let stampDuty = 0;
  if (side === 'buy') {
    if (segment === 'EQ' && product === 'CNC') {
      stampDuty = turnover * 0.00015;   // 0.015 % capped at ₹1500/day (we omit the cap)
    } else if (segment === 'EQ') {
      stampDuty = turnover * 0.00003;   // 0.003 % intraday
    } else if (segment === 'FNO' && !input.isOption) {
      stampDuty = turnover * 0.00002;   // 0.002 % futures
    } else if (segment === 'FNO' && input.isOption) {
      stampDuty = turnover * 0.00003;   // 0.003 % on PREMIUM × QTY (buyer side only)
    } else if (segment === 'COMMODITY') {
      stampDuty = turnover * 0.00002;   // 0.002 % (non-agri)
    } else if (segment === 'CURRENCY') {
      stampDuty = turnover * 0.00001;   // 0.001 %
    }
  }

  // ---------- 6. Depository (DP) charge — equity delivery SELL only ----------
  let dpCharges = 0;
  if (segment === 'EQ' && product === 'CNC' && side === 'sell') {
    dpCharges = DP_CHARGE_FLAT;
    notes.push('DP charge ₹13.5 (delivery sell)');
  }

  // ---------- 7. GST = 18 % of (brokerage + exchangeTxn + SEBI + DP) ----------
  const gst = (brokerage + exchangeTxn + sebi + dpCharges) * 0.18;

  const total = brokerage + stt + exchangeTxn + sebi + stampDuty + dpCharges + gst;

  return {
    brokerage:   round2(brokerage),
    stt:         round2(stt),
    exchangeTxn: round2(exchangeTxn),
    sebi:        round2(sebi),
    stampDuty:   round2(stampDuty),
    dpCharges:   round2(dpCharges),
    gst:         round2(gst),
    total:       round2(total),
    notes,
  };
}
