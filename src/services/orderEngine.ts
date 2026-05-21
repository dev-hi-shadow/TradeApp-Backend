import { Types } from 'mongoose';
import { Order, IOrder } from '../models/Order';
import { Position } from '../models/Position';
import { Transaction } from '../models/Transaction';
import { User } from '../models/User';
import { Quote, getLatestCached, toYahooSymbol, fetchQuotes, fetchSnapshot } from './marketData';
import { computeCharges, type Segment, type Product, type Side } from './charges';
import { requiredMargin, cashImpactOnOpen } from './margin';
import { scripMaster } from './scripMaster';

/**
 * Best-effort inference of which Indian-market segment a symbol belongs to.
 *
 * Option contracts always have a numeric strike + month-code immediately
 * before the CE/PE suffix (e.g. NIFTY26MAY2623400CE, RELIANCE20JUN242500PE).
 * The leading digit guard rejects equity names that happen to end in "CE"
 * (RELIAN**CE**, IDFCFIRSTBANK, INFRACABLES, …) or "PE" (PRESTI**PE**).
 *
 * Index detection: prefer scrip-master `instrumenttype` (OPTIDX / OPTSTK)
 * over a hand-maintained regex, since SEBI keeps adding new index series
 * (MIDCPNIFTY, NIFTYNXT50, BANKEX …).
 */
export function inferSegment(symbol: string): {
  segment: Segment;
  isOption: boolean;
  isStockOption: boolean;
  underlying?: string;
} {
  const s = symbol.toUpperCase();
  const isOption = /\d(?:CE|PE)$/.test(s);

  if (isOption) {
    // Try the scrip master first — authoritative, expanded automatically.
    const meta = scripMaster.findOptionByTradingSymbol?.(s);
    const isIndex = meta
      ? meta.instrumenttype === 'OPTIDX'
      : /^(NIFTY|BANKNIFTY|FINNIFTY|MIDCPNIFTY|NIFTYNXT50|SENSEX|BANKEX)/.test(s);
    return {
      segment: 'FNO',
      isOption: true,
      isStockOption: !isIndex,
      underlying: meta?.name,
    };
  }
  if (/FUT$/.test(s)) {
    if (/^(GOLD|SILVER|CRUDEOIL|NATURALGAS|COPPER|ZINC|LEAD|ALUMINIUM)/.test(s)) {
      return { segment: 'COMMODITY', isOption: false, isStockOption: false };
    }
    return { segment: 'FNO', isOption: false, isStockOption: false };
  }
  if (/^(GOLD|SILVER|CRUDEOIL|NATURALGAS|COPPER|ZINC|LEAD|ALUMINIUM)$/.test(s)) {
    return { segment: 'COMMODITY', isOption: false, isStockOption: false };
  }
  return { segment: 'EQ', isOption: false, isStockOption: false };
}

export interface PositionSnapshot {
  symbol: string;
  netQuantity: number;
  avgEntryPrice: number;
  realisedPnL: number;
  marginBlocked: number;
  product: Product;
}

export interface FillResult {
  order: IOrder;
  fillPrice: number;
  newBalance: number;
  positionSnapshot: PositionSnapshot | null;
  charges: {
    brokerage: number;
    stt: number;
    exchangeTxn: number;
    sebi: number;
    stampDuty: number;
    gst: number;
    total: number;
  };
}

/**
 * Resolve the underlying spot for an option symbol (needed for SPAN-style
 * SELL margin). For NIFTY26MAY2623400CE → returns NIFTY's current price.
 * Returns 0 if no live quote is cached.
 */
async function underlyingSpotFor(symbol: string): Promise<number> {
  const s = symbol.toUpperCase();
  // Pull the prefix portion of the option name (everything up to the first
  // digit followed by month code) — heuristic but works for both index
  // (NIFTY…) and stock (RELIANCE…) options.
  const m = s.match(/^([A-Z]+?)(\d{2}[A-Z]{3}\d{2})/);
  const underlying = m ? m[1] : '';
  if (!underlying) return 0;
  const cached = getLatestCached(toYahooSymbol(underlying));
  if (cached?.price) return cached.price;
  try {
    const fresh = await fetchQuotes([underlying]);
    return fresh[0]?.price ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Apply a buy/sell fill to a per-(user, symbol, product) position WITH the
 * Zerodha-style cash/margin separation:
 *
 *   • cashImpact     — signed wallet movement (premium for options, full
 *                      notional for CNC equity, zero for MIS/NRML non-option)
 *   • realisedDelta  — newly realised P&L for this fill
 *   • marginDelta    — change in margin block (positive = more blocked,
 *                      negative = released)
 *
 * Wallet update at the call site:
 *   newBalance = balance + cashImpact + realisedDelta − marginDelta − charges
 */
async function applyFillToPosition(
  userId: Types.ObjectId,
  symbol: string,
  side: 'buy' | 'sell',
  quantity: number,
  fillPrice: number,
  product: Product,
  marginRateOf: (side: 'buy' | 'sell', qty: number, avg: number) => Promise<number>,
  cashImpactOf: (side: 'buy' | 'sell', qty: number, fillPrice: number) => number,
): Promise<{
  snapshot: PositionSnapshot | null;
  realisedDelta: number;
  marginDelta: number;
  cashImpact: number;
}> {
  const sym = symbol.toUpperCase();
  let pos = await Position.findOne({ userId, symbol: sym, product });
  let realisedDelta = 0;

  if (!pos) {
    pos = new Position({
      userId,
      symbol: sym,
      netQuantity: 0,
      avgEntryPrice: 0,
      realisedPnL: 0,
      marginBlocked: 0,
      product,
    });
  }

  const signedDelta = side === 'buy' ? quantity : -quantity;
  const oldQty = pos.netQuantity;
  const oldAvg = pos.avgEntryPrice;
  const oldMargin = pos.marginBlocked;
  const newQty = oldQty + signedDelta;

  if (oldQty === 0) {
    pos.avgEntryPrice = fillPrice;
    pos.netQuantity = newQty;
  } else if (Math.sign(oldQty) === Math.sign(signedDelta)) {
    // Adding to existing position → weighted average
    pos.avgEntryPrice =
      (Math.abs(oldQty) * oldAvg + Math.abs(signedDelta) * fillPrice) / Math.abs(newQty);
    pos.netQuantity = newQty;
  } else {
    // Opposite direction — realise P&L on the closed portion
    const closedQty = Math.min(Math.abs(oldQty), Math.abs(signedDelta));
    const pnlPerUnit = oldQty > 0 ? fillPrice - oldAvg : oldAvg - fillPrice;
    realisedDelta = pnlPerUnit * closedQty;
    pos.realisedPnL += realisedDelta;

    pos.netQuantity = newQty;
    if (newQty === 0) {
      pos.avgEntryPrice = 0;
    } else if (Math.sign(newQty) !== Math.sign(oldQty)) {
      // Flipped to opposite side: open a fresh leg at fillPrice
      pos.avgEntryPrice = fillPrice;
    }
    // Else partially reduced: avgEntryPrice unchanged.
  }

  // Cash impact uses the actual fill quantity (not the new position size).
  const cashImpact = cashImpactOf(side, quantity, fillPrice);

  // Recompute margin block using the CURRENT position's effective side & avg.
  // For closed positions (netQuantity === 0) margin = 0.
  let newMargin = 0;
  if (pos.netQuantity !== 0) {
    const effectiveSide: 'buy' | 'sell' = pos.netQuantity > 0 ? 'buy' : 'sell';
    const rate = await marginRateOf(effectiveSide, Math.abs(pos.netQuantity), pos.avgEntryPrice);
    newMargin = Math.abs(pos.netQuantity) * pos.avgEntryPrice * rate;
  }
  pos.marginBlocked = newMargin;
  const marginDelta = newMargin - oldMargin;

  await pos.save();

  return {
    snapshot: {
      symbol: sym,
      netQuantity: pos.netQuantity,
      avgEntryPrice: pos.avgEntryPrice,
      realisedPnL: pos.realisedPnL,
      marginBlocked: pos.marginBlocked,
      product: pos.product,
    },
    realisedDelta,
    marginDelta,
    cashImpact,
  };
}

/**
 * Execute a (market or limit) order at the given fill price.
 *
 * Idempotent — refuses orders that are already filled/cancelled. Accepts
 * 'pending' (market entry) or 'filling' (limit-matcher claim) as entry.
 */
export async function executeFill(order: IOrder, fillPrice: number): Promise<FillResult> {
  if (order.status !== 'pending' && order.status !== 'filling') {
    throw new Error(`Cannot execute order in status "${order.status}"`);
  }

  const user = await User.findById(order.userId);
  if (!user) throw new Error('User not found');

  const seg = inferSegment(order.symbol);
  const product: Product =
    ((order as any).product as Product) ||
    (seg.segment === 'EQ' ? 'CNC' : 'NRML');

  // Lot-size validation for F&O / commodity contracts: quantity must be an
  // exact multiple of the contract's lot size. Equity has lot 1 implicitly.
  const lotSize = lookupLotSize(order.symbol);
  if (lotSize > 1 && order.quantity % lotSize !== 0) {
    order.status = 'rejected';
    order.rejectReason = `Quantity must be a multiple of lot size (${lotSize})`;
    await order.save();
    throw new Error(`Quantity must be a multiple of lot size (${lotSize})`);
  }

  // Underlying spot is required for SPAN-style margin on option SELLs.
  let underlyingSpot = 0;
  if (seg.isOption) {
    underlyingSpot = await underlyingSpotFor(order.symbol);
  }

  const charges = computeCharges({
    segment: seg.segment,
    product,
    side: order.side as Side,
    price: fillPrice,
    quantity: order.quantity,
    isOption: seg.isOption,
    isStockOption: seg.isStockOption,
  });

  // Margin rate is computed dynamically per current position side (so a
  // side-flip uses the NEW side's rate, not the entry side's).
  const marginRateOf = async (
    effectiveSide: 'buy' | 'sell',
    qty: number,
    avg: number,
  ): Promise<number> => {
    const m = requiredMargin({
      segment: seg.segment,
      product,
      side: effectiveSide,
      price: avg,
      quantity: qty,
      isOption: seg.isOption,
      isStockOption: seg.isStockOption,
      underlyingSpot,
    });
    return qty > 0 && avg > 0 ? m / (qty * avg) : 0;
  };

  const cashImpactOf = (side: 'buy' | 'sell', qty: number, px: number): number =>
    cashImpactOnOpen({
      segment: seg.segment,
      product,
      side,
      price: px,
      quantity: qty,
      isOption: seg.isOption,
      isStockOption: seg.isStockOption,
      underlyingSpot,
    });

  let snapshot: PositionSnapshot | null = null;
  let cashImpact = 0;
  let realisedDelta = 0;
  let marginDelta = 0;
  try {
    const r = await applyFillToPosition(
      order.userId,
      order.symbol,
      order.side,
      order.quantity,
      fillPrice,
      product,
      marginRateOf,
      cashImpactOf,
    );
    snapshot = r.snapshot;
    cashImpact = r.cashImpact;
    realisedDelta = r.realisedDelta;
    marginDelta = r.marginDelta;
  } catch (err) {
    order.status = 'pending';
    await order.save();
    throw err;
  }

  // Wallet equation:
  //   newBalance = balance + cashImpact + realisedDelta − marginDelta − charges
  // where:
  //   • cashImpact     = signed premium / full notional cash flow
  //   • realisedDelta  = realised P&L on closed portion
  //   • marginDelta    = +blocked / −released
  //   • charges        = always positive, deducted
  const newBalance =
    user.virtualBalance + cashImpact + realisedDelta - marginDelta - charges.total;

  if (newBalance < 0) {
    // Roll back the position state, restore old margin block.
    try {
      await applyFillToPosition(
        order.userId,
        order.symbol,
        order.side === 'buy' ? 'sell' : 'buy',
        order.quantity,
        fillPrice,
        product,
        marginRateOf,
        cashImpactOf,
      );
    } catch {
      /* best-effort rollback */
    }
    order.status = 'rejected';
    const shortBy = -newBalance;
    const have = user.virtualBalance;
    const need = have + shortBy;
    order.rejectReason =
      `Insufficient margin: need ₹${fmt2(need)}, have ₹${fmt2(have)} (short ₹${fmt2(shortBy)})`;
    await order.save();
    throw new Error(order.rejectReason);
  }

  user.virtualBalance = newBalance;
  await user.save();

  order.status = 'filled';
  order.filledPrice = fillPrice;
  order.filledAt = new Date();
  await order.save();

  await Transaction.create({
    userId: order.userId,
    orderId: order._id,
    symbol: order.symbol,
    side: order.side,
    quantity: order.quantity,
    price: fillPrice,
    charges: {
      brokerage: charges.brokerage,
      stt: charges.stt,
      exchangeTxn: charges.exchangeTxn,
      sebi: charges.sebi,
      stampDuty: charges.stampDuty,
      gst: charges.gst,
      total: charges.total,
    },
  });

  return {
    order,
    fillPrice,
    newBalance: user.virtualBalance,
    positionSnapshot: snapshot,
    charges: {
      brokerage:   charges.brokerage,
      stt:         charges.stt,
      exchangeTxn: charges.exchangeTxn,
      sebi:        charges.sebi,
      stampDuty:   charges.stampDuty,
      gst:         charges.gst,
      total:       charges.total,
    },
  };
}

/** Pure preview used by the order modal. */
export function previewCharges(
  symbol: string,
  side: 'buy' | 'sell',
  price: number,
  quantity: number,
  product: Product = 'CNC',
) {
  const seg = inferSegment(symbol);
  return computeCharges({
    segment: seg.segment,
    product,
    side,
    price,
    quantity,
    isOption: seg.isOption,
    isStockOption: seg.isStockOption,
  });
}

/**
 * Margin block preview for the order modal. For option SELL needs the
 * underlying spot — caller can pass it in, otherwise we look it up.
 */
export async function previewMarginBlock(
  symbol: string,
  side: 'buy' | 'sell',
  price: number,
  quantity: number,
  product: Product = 'CNC',
): Promise<{ marginBlocked: number; cashImpact: number; underlyingSpot: number }> {
  const seg = inferSegment(symbol);
  const underlyingSpot = seg.isOption ? await underlyingSpotFor(symbol) : 0;
  const m = requiredMargin({
    segment: seg.segment,
    product,
    side,
    price,
    quantity,
    isOption: seg.isOption,
    isStockOption: seg.isStockOption,
    underlyingSpot,
  });
  const c = cashImpactOnOpen({
    segment: seg.segment,
    product,
    side,
    price,
    quantity,
    isOption: seg.isOption,
    isStockOption: seg.isStockOption,
    underlyingSpot,
  });
  return { marginBlocked: m, cashImpact: c, underlyingSpot };
}

/**
 * For a price tick on a symbol, atomically claim any pending limit orders
 * that should fill. Each claimed order has its status flipped to "filling"
 * via findOneAndUpdate so a concurrent tick can't double-fill.
 *
 * Caller MUST follow up with executeFill() to flip "filling" → "filled".
 */
export async function matchLimitOrders(
  userId: Types.ObjectId,
  symbol: string,
  currentPrice: number,
): Promise<IOrder[]> {
  const sym = symbol.toUpperCase();
  const candidates = await Order.find({
    userId,
    symbol: sym,
    status: 'pending',
    type: 'limit',
  });

  const claimed: IOrder[] = [];
  for (const o of candidates) {
    if (o.price == null) continue;
    const shouldFill =
      (o.side === 'buy' && currentPrice <= o.price) ||
      (o.side === 'sell' && currentPrice >= o.price);
    if (!shouldFill) continue;
    const taken = await Order.findOneAndUpdate(
      { _id: o._id, status: 'pending' },
      { $set: { status: 'filling' } },
      { new: true },
    );
    if (taken) claimed.push(taken);
  }
  return claimed;
}

export interface PortfolioSummary {
  balance: number;
  holdingsValue: number;
  totalValue: number;
  unrealisedPnL: number;
  realisedPnL: number;
  marginUsed: number;
  availableMargin: number;
  positions: Array<{
    symbol: string;
    netQuantity: number;
    avgEntryPrice: number;
    lastPrice: number;
    marketValue: number;
    unrealisedPnL: number;
    realisedPnL: number;
    marginBlocked: number;
    product: 'CNC' | 'MIS' | 'NRML';
  }>;
}

/**
 * Compute the portfolio summary given a quote-by-symbol map.
 *
 *   balance         — cash in the wallet
 *   marginUsed      — sum of all open positions' marginBlocked
 *   availableMargin = balance − any UNREALISED LOSS on open positions
 *                     (broker rule: unrealised losses immediately reduce
 *                      free margin so you can't double-commit)
 *   holdingsValue   — current mark-to-market of open positions
 *   totalValue      — balance + marginUsed + unrealised P&L (equity NAV)
 */
export async function computePortfolio(
  userId: Types.ObjectId,
  quotesBySymbol: Map<string, Quote>,
): Promise<PortfolioSummary> {
  const [user, positions] = await Promise.all([
    User.findById(userId),
    Position.find({ userId }),
  ]);
  if (!user) throw new Error('User not found');

  let holdingsValue = 0;
  let unrealisedPnL = 0;
  let realisedPnL = 0;
  let marginUsed = 0;

  const posView = positions
    .filter((p) => p.netQuantity !== 0)
    .map((p) => {
      const q = quotesBySymbol.get(p.symbol.toUpperCase());
      const last = q?.price ?? p.avgEntryPrice;
      const marketValue = last * p.netQuantity;
      const upl = (last - p.avgEntryPrice) * p.netQuantity;
      holdingsValue += marketValue;
      unrealisedPnL += upl;
      realisedPnL += p.realisedPnL;
      marginUsed += p.marginBlocked || 0;
      return {
        symbol: p.symbol,
        netQuantity: p.netQuantity,
        avgEntryPrice: p.avgEntryPrice,
        lastPrice: last,
        marketValue,
        unrealisedPnL: upl,
        realisedPnL: p.realisedPnL,
        marginBlocked: p.marginBlocked || 0,
        product: p.product || 'CNC',
      };
    });

  const closed = positions.filter((p) => p.netQuantity === 0);
  for (const p of closed) realisedPnL += p.realisedPnL;

  const unrealisedLoss = Math.max(0, -unrealisedPnL);
  const availableMargin = Math.max(0, user.virtualBalance - unrealisedLoss);

  return {
    balance: user.virtualBalance,
    holdingsValue,
    totalValue: user.virtualBalance + marginUsed + unrealisedPnL,
    unrealisedPnL,
    realisedPnL,
    marginUsed,
    availableMargin,
    positions: posView,
  };
}

/* ---------- helpers ---------- */

function fmt2(n: number): string {
  return (Math.round(n * 100) / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Look up the lot size for any tradable symbol via the scrip master.
 * Returns 1 for equity / cash. Returns the contract's published lot for
 * F&O / commodity. Falls back to a conservative 1 if unknown — orderEngine
 * won't reject an order whose lot can't be resolved, only one whose
 * quantity violates a KNOWN lot multiple.
 */
export function lookupLotSize(symbol: string): number {
  const s = symbol.toUpperCase();
  if (scripMaster.lotSizeFor) {
    const ls = scripMaster.lotSizeFor(s);
    if (ls && ls > 0) return ls;
  }
  return 1;
}
