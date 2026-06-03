import { Types } from 'mongoose';
import { Order, IOrder } from '../models/Order';
import { Position } from '../models/Position';
import { PositionGuard } from '../models/PositionGuard';
import { Transaction } from '../models/Transaction';
import { User } from '../models/User';
import { Quote, getLatestCached, getLastKnownPrice, toYahooSymbol, fetchQuotes, fetchSnapshot, getDepthCached } from './marketData';
import { computeCharges, type Segment, type Product, type Side } from './charges';
import { requiredMargin, cashImpactOnOpen } from './margin';
import { applySlippage, walkBook, vwapOfLevels, availableQty } from './slippage';
import { scripMaster } from './scripMaster';
import { isTradingOpen, marketStatus, type MarketStatus } from './marketSession';

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

/** Is the market for this symbol's segment open for trading right now (IST)? */
export function isSymbolTradingOpen(symbol: string): boolean {
  return isTradingOpen(inferSegment(symbol).segment);
}

/** Market status (open/closed + reason) for this symbol's segment. */
export function marketStatusForSymbol(symbol: string): MarketStatus {
  return marketStatus(inferSegment(symbol).segment);
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
    dpCharges: number;
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
 * Execute a (market / limit / SL) order at the given fill price.
 *
 * Idempotent — refuses orders that are already filled/cancelled. Accepts
 * 'pending' (market entry), 'filling' (matcher claim) or 'partial'
 * (already partially filled, resting for more) as entry.
 *
 * `fillQuantity` lets the matcher fill an order in slices (partial fills).
 * When omitted, the order is filled for its entire REMAINING quantity
 * (quantity − filledQuantity) — the classic full-fill behaviour, so every
 * existing caller (market orders, square-off, exits) is unchanged.
 */
export async function executeFill(
  order: IOrder,
  fillPrice: number,
  fillQuantity?: number,
): Promise<FillResult> {
  if (order.status !== 'pending' && order.status !== 'filling' && order.status !== 'partial') {
    throw new Error(`Cannot execute order in status "${order.status}"`);
  }

  const alreadyFilled = order.filledQuantity || 0;
  const remaining = order.quantity - alreadyFilled;
  if (remaining <= 0) throw new Error('Order already fully filled');
  // Clamp the requested slice to what's left.
  const fillQty = fillQuantity != null ? Math.min(fillQuantity, remaining) : remaining;
  if (fillQty <= 0) throw new Error('Fill quantity must be > 0');

  const user = await User.findById(order.userId);
  if (!user) throw new Error('User not found');

  const seg = inferSegment(order.symbol);
  const product: Product =
    ((order as any).product as Product) ||
    (seg.segment === 'EQ' ? 'CNC' : 'NRML');

  // Lot-size validation: each fill slice must itself be a lot multiple so the
  // resting remainder also stays lot-aligned. Equity has lot 1 implicitly.
  const lotSize = lookupLotSize(order.symbol);
  if (lotSize > 1 && fillQty % lotSize !== 0) {
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
    quantity: fillQty,
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
      fillQty,
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
  //   newBalance = balance + cashImpact + realisedToWallet − marginDelta − charges
  //
  // CASH-settled fills (options, EQ CNC) move the FULL notional through
  // `cashImpact` on BOTH legs, so the P&L is already embedded in that cash
  // flow (buy −cost, sell +proceeds = net P&L). Adding `realisedDelta` on top
  // would double-count it. MARGIN-model fills (futures / MIS) have cashImpact
  // === 0, so there `realisedDelta` IS the realised P&L and must be applied.
  // (pos.realisedPnL still records it for reporting either way.)
  const realisedToWallet = cashImpact === 0 ? realisedDelta : 0;
  const newBalance =
    user.virtualBalance + cashImpact + realisedToWallet - marginDelta - charges.total;

  if (newBalance < 0) {
    // Roll back the position state, restore old margin block.
    try {
      await applyFillToPosition(
        order.userId,
        order.symbol,
        order.side === 'buy' ? 'sell' : 'buy',
        fillQty,
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

  // ── Accumulate the (partial) fill onto the order ──
  const prevFilled = order.filledQuantity || 0;
  const prevAvg = order.avgFillPrice || 0;
  const newFilled = prevFilled + fillQty;
  // Volume-weighted average across all slices of THIS order.
  order.avgFillPrice = (prevFilled * prevAvg + fillQty * fillPrice) / newFilled;
  order.filledPrice = order.avgFillPrice; // back-compat alias
  order.filledQuantity = newFilled;
  if (newFilled >= order.quantity) {
    order.status = 'filled';
    order.filledAt = new Date();
  } else {
    order.status = 'partial';
  }
  // Mirror the charges actually booked (this fill) onto the order, ACCUMULATING
  // across partial fills — so order history shows the same cost the wallet paid
  // via the Transaction ledger. `charges` here is for this fill's quantity.
  const oc = order.charges ?? {
    brokerage: 0, stt: 0, exchangeTxn: 0, sebi: 0, stampDuty: 0, dpCharges: 0, gst: 0, total: 0,
  };
  order.charges = {
    brokerage:   oc.brokerage   + charges.brokerage,
    stt:         oc.stt         + charges.stt,
    exchangeTxn: oc.exchangeTxn + charges.exchangeTxn,
    sebi:        oc.sebi        + charges.sebi,
    stampDuty:   oc.stampDuty   + charges.stampDuty,
    dpCharges:   oc.dpCharges   + charges.dpCharges,
    gst:         oc.gst         + charges.gst,
    total:       oc.total       + charges.total,
  };
  await order.save();

  await Transaction.create({
    userId: order.userId,
    orderId: order._id,
    symbol: order.symbol,
    side: order.side,
    quantity: fillQty,
    price: fillPrice,
    charges: {
      brokerage: charges.brokerage,
      stt: charges.stt,
      exchangeTxn: charges.exchangeTxn,
      sebi: charges.sebi,
      stampDuty: charges.stampDuty,
      dpCharges: charges.dpCharges,
      gst: charges.gst,
      total: charges.total,
    },
    realisedPnL: realisedDelta,
    cashImpact,
  });

  // ── Bracket: arm SL / target as a PositionGuard once the ENTRY fully fills ──
  // Only when this order carried bracket levels AND it actually left an OPEN
  // position (an entry, not a close). Reuses the existing guard auto-exit engine.
  if (
    order.status === 'filled' &&
    (order.bracketStopLoss != null || order.bracketTarget != null) &&
    snapshot &&
    snapshot.netQuantity !== 0
  ) {
    try {
      await PositionGuard.findOneAndUpdate(
        { userId: order.userId, symbol: order.symbol, product: snapshot.product },
        {
          $set: {
            stopLossPrice: order.bracketStopLoss && order.bracketStopLoss > 0 ? order.bracketStopLoss : undefined,
            targetPrice: order.bracketTarget && order.bracketTarget > 0 ? order.bracketTarget : undefined,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );
    } catch (err: any) {
      console.error('[bracket] failed to arm guard:', err.message || err);
    }
  }

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
      dpCharges:   charges.dpCharges,
      gst:         charges.gst,
      total:       charges.total,
    },
  };
}

/**
 * Effective market fill price for a symbol, computed by walking the REAL live
 * order book (Angel FULL-mode depth) against actual available volume:
 *
 *   • buy  lifts the ask side level-by-level (cheapest offers first),
 *   • sell hits the bid side level-by-level (highest bids first),
 *
 * returning the volume-weighted average. Orders larger than the visible 5
 * levels get a synthetic tail for the unseen remainder. When depth isn't
 * available (Angel off / FULL not subscribed / non-Angel symbol) it falls back
 * to the synthetic spread+impact model — so a fill is always priced.
 *
 * Used by every market-order path (manual market order, exits, square-off,
 * guard auto-exit) so a market order never fills at the unrealistically clean
 * single LTP.
 */
export interface MarketFillQuote {
  fillPrice: number;
  /** 'book' = walked the REAL cached order book; 'synthetic' = spread+impact model. */
  mode: 'book' | 'synthetic';
  /** Real volume consumed from the visible book (0 for synthetic). */
  bookQty: number;
  /** True when the order exceeded the visible book (synthetic tail applied). */
  exhausted: boolean;
}

/**
 * QUIET fill pricer (no logging) — shared by the live fill path and the order
 * preview. Cache-only depth; walks the real book when available, else synthetic.
 */
export function quoteMarketFill(
  symbol: string,
  side: 'buy' | 'sell',
  quantity: number,
  ltp: number,
): MarketFillQuote {
  const seg = inferSegment(symbol);
  const isFuture = /FUT$/.test(symbol.toUpperCase());
  const dq = getDepthCached(symbol);
  const levels = side === 'buy' ? dq?.sell : dq?.buy;
  if (dq && levels && levels.length > 0) {
    const w = walkBook(side, quantity, dq.ltp || ltp, levels, seg.segment, seg.isOption, isFuture);
    return { fillPrice: w.fillPrice, mode: 'book', bookQty: w.bookQty, exhausted: w.exhausted };
  }
  const s = applySlippage({ side, quantity, ltp, segment: seg.segment, isOption: seg.isOption, isFuture });
  return { fillPrice: s.fillPrice, mode: 'synthetic', bookQty: 0, exhausted: true };
}

export function marketFillPrice(
  symbol: string,
  side: 'buy' | 'sell',
  quantity: number,
  ltp: number,
): number {
  // Cache-ONLY depth — never a network call on the fill path, so fills/exits
  // stay millisecond-fast. (Cache is kept warm by the price loop + preview.)
  const q = quoteMarketFill(symbol, side, quantity, ltp);
  console.log(
    q.mode === 'book'
      ? `[fill] ${symbol} ${side} ${quantity} → REAL book VWAP ₹${q.fillPrice} ` +
          `(book qty ${q.bookQty}/${quantity}${q.exhausted ? ', +synthetic tail' : ''}, ltp ₹${ltp})`
      : `[fill] ${symbol} ${side} ${quantity} → SYNTHETIC ₹${q.fillPrice} (no cached depth, ltp ₹${ltp})`,
  );
  return q.fillPrice;
}

/** Cache-first LTP for a fill (no network unless the symbol was never seen). */
async function ltpForFill(symbol: string): Promise<number> {
  const c = getLatestCached(toYahooSymbol(symbol))?.price;
  if (c && c > 0) return c;
  const lkg = getLastKnownPrice(symbol)?.price ?? getLastKnownPrice(toYahooSymbol(symbol))?.price;
  if (lkg && lkg > 0) return lkg;
  const qs = await fetchQuotes([symbol]);
  const px = qs[0]?.price;
  if (!px || px <= 0) throw new Error(`No live quote available for ${symbol}`);
  return px;
}

export interface CloseResult {
  ok: boolean;
  symbol: string;
  product?: Product;
  fillPrice?: number;
  newBalance?: number;
  realisedPnL?: number | null;
  error?: string;
}

/**
 * Close open positions at market — shared by the REST exit routes AND the WS
 * exit handler so both use the identical (fast, cache-priced) fill path.
 * Pass `symbol` to close one symbol, omit it to close everything.
 * Returns per-symbol results plus the FillResult objects (so the WS layer can
 * stream `orderFilled` events to the client).
 */
export async function closePositions(
  userId: Types.ObjectId | string,
  opts: { symbol?: string; product?: Product } = {},
): Promise<{ results: CloseResult[]; fills: FillResult[] }> {
  const filter: any = { userId, netQuantity: { $ne: 0 } };
  if (opts.symbol) filter.symbol = opts.symbol.toUpperCase();
  if (opts.product) filter.product = opts.product;

  const positions = await Position.find(filter);
  const results: CloseResult[] = [];
  const fills: FillResult[] = [];

  for (const p of positions) {
    // Market-hours gate — no manual exits after close (the position rides to the
    // next session; any armed SL/target fires at open). Skips this position so
    // exit-all still closes whatever IS open (e.g. MCX while NSE is shut).
    if (!isSymbolTradingOpen(p.symbol)) {
      results.push({ ok: false, symbol: p.symbol, product: p.product, error: marketStatusForSymbol(p.symbol).reason });
      continue;
    }
    try {
      const ltp = await ltpForFill(p.symbol);
      const side: 'buy' | 'sell' = p.netQuantity > 0 ? 'sell' : 'buy';
      const qty = Math.abs(p.netQuantity);
      const order = await Order.create({
        userId,
        symbol: p.symbol,
        type: 'market',
        side,
        quantity: qty,
        product: p.product,
        status: 'filling',
      });
      const fill = await executeFill(order, marketFillPrice(p.symbol, side, qty, ltp));
      fills.push(fill);
      results.push({
        ok: true,
        symbol: p.symbol,
        product: p.product,
        fillPrice: fill.fillPrice,
        newBalance: fill.newBalance,
        realisedPnL: fill.positionSnapshot?.realisedPnL ?? null,
      });
    } catch (err: any) {
      results.push({ ok: false, symbol: p.symbol, product: p.product, error: err.message });
    }
  }
  return { results, fills };
}

/** Products a segment can be converted between (Groww/Dhan rules). */
function convertibleProducts(segment: Segment): Product[] {
  if (segment === 'EQ') return ['CNC', 'MIS'];          // delivery ↔ intraday
  return ['NRML', 'MIS'];                                 // F&O / commodity: carry ↔ intraday
}

/**
 * Convert an OPEN position between products (MIS↔CNC for equity, MIS↔NRML for
 * F&O). Re-blocks margin and adjusts the wallet by the change in *committed
 * capital* (cash debited + margin blocked) — computed with the SAME helpers the
 * fill path uses, so the accounting stays consistent. For F&O the committed
 * amount is identical across MIS/NRML, so it's effectively a relabel (changes
 * only the auto-square-off behaviour). For equity MIS→CNC it debits the extra
 * delivery cash (and rejects if the wallet can't cover it).
 */
export async function convertPosition(
  userId: Types.ObjectId | string,
  symbol: string,
  toProduct: Product,
  fromProduct?: Product,
): Promise<{ ok: boolean; error?: string; product?: Product; newBalance?: number; marginBlocked?: number }> {
  const sym = symbol.toUpperCase();
  const filter: any = { userId, symbol: sym, netQuantity: { $ne: 0 } };
  if (fromProduct) filter.product = fromProduct;
  const pos = await Position.findOne(filter);
  if (!pos) return { ok: false, error: 'No open position to convert' };
  if (pos.product === toProduct) return { ok: false, error: `Already ${toProduct}` };

  const seg = inferSegment(sym);
  const allowed = convertibleProducts(seg.segment);
  if (!allowed.includes(toProduct) || !allowed.includes(pos.product)) {
    return { ok: false, error: `${sym} can't convert ${pos.product} → ${toProduct}` };
  }
  // A position already held in the target product would collide with the unique
  // (user, symbol, product) index — merging isn't supported.
  const existingTarget = await Position.findOne({ userId, symbol: sym, product: toProduct, netQuantity: { $ne: 0 } });
  if (existingTarget) {
    return { ok: false, error: `You already hold ${sym} in ${toProduct} — close one leg first` };
  }

  const side: 'buy' | 'sell' = pos.netQuantity > 0 ? 'buy' : 'sell';
  const qty = Math.abs(pos.netQuantity);
  const underlyingSpot = seg.isOption ? await underlyingSpotFor(sym) : 0;
  const committed = (product: Product): number => {
    const base = { segment: seg.segment, side, price: pos.avgEntryPrice, quantity: qty, isOption: seg.isOption, isStockOption: seg.isStockOption, underlyingSpot, product };
    const cash = Math.max(0, -cashImpactOnOpen(base));
    return cash + requiredMargin(base);
  };

  const user = await User.findById(userId);
  if (!user) return { ok: false, error: 'User not found' };

  const delta = committed(pos.product) - committed(toProduct); // +ve = capital freed
  const newBalance = user.virtualBalance + delta;
  if (newBalance < 0) {
    return { ok: false, error: `Insufficient funds to convert — need ₹${fmt2(-delta)} more` };
  }

  pos.product = toProduct;
  pos.marginBlocked = requiredMargin({ segment: seg.segment, side, price: pos.avgEntryPrice, quantity: qty, isOption: seg.isOption, isStockOption: seg.isStockOption, underlyingSpot, product: toProduct });
  user.virtualBalance = newBalance;
  await Promise.all([pos.save(), user.save()]);

  return { ok: true, product: toProduct, newBalance, marginBlocked: pos.marginBlocked };
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

/** Distinct symbols that currently have a resting (pending/partial) order
 *  needing price ticks — so the price loop can include them even when no
 *  client is subscribed (limit/SL orders must fill while you're logged out). */
export async function symbolsWithRestingOrders(): Promise<string[]> {
  return Order.distinct('symbol', {
    status: { $in: ['pending', 'partial'] },
    type: { $in: ['limit', 'sl', 'sl-m'] },
  });
}

/** Symbols with at least one OPEN position (for depth warming → real-volume exits). */
export async function symbolsWithOpenPositions(): Promise<string[]> {
  return Position.distinct('symbol', { netQuantity: { $ne: 0 } });
}

/** Per-tick fill slice for partial fills. Small orders (≤3 lots) fill whole;
 *  larger orders fill ~40% per tick (lot-aligned) so they walk across ticks. */
function partialSlice(remaining: number, lot: number): number {
  const lots = Math.max(1, Math.round(remaining / lot));
  if (lots <= 3) return remaining;
  return Math.ceil(lots * 0.4) * lot;
}

export interface RestingFillEvent {
  userId: string;
  kind: 'filled' | 'rejected' | 'cancelled';
  order: IOrder;
  fill?: FillResult;
  reason?: string;
}

/**
 * Server-side matcher for ALL resting orders on a symbol at a given tick.
 *
 * Runs globally on the price loop (not per WebSocket connection) so resting
 * limit / stop orders fill even when the owner is disconnected — the previous
 * per-connection matcher silently stalled resting orders the moment a user
 * closed the tab.
 *
 * Order-type semantics (Zerodha-accurate):
 *   • limit — fills when LTP reaches the limit; fill price = limit or better
 *             (never worse than the user's price).
 *   • sl-m  — Stop-Loss MARKET: when LTP crosses triggerPrice, fills at market
 *             (LTP + slippage).
 *   • sl    — Stop-Loss LIMIT: on trigger it CONVERTS to a limit @ price (the
 *             real broker behaviour) and fills under limit rules thereafter.
 *
 * Validity: IOC cancels any unfilled remainder after this tick; GTT past its
 * expiry is auto-cancelled.
 */
export async function processRestingOrders(symbol: string, currentPrice: number): Promise<RestingFillEvent[]> {
  const sym = symbol.toUpperCase();
  const events: RestingFillEvent[] = [];
  if (!(currentPrice > 0)) return events;

  const candidates = await Order.find({
    symbol: sym,
    status: { $in: ['pending', 'partial'] },
    type: { $in: ['limit', 'sl', 'sl-m'] },
  });

  const seg = inferSegment(sym);
  const isFuture = /FUT$/.test(sym);
  const lot = lookupLotSize(sym);
  const now = Date.now();

  for (let o of candidates) {
    // GTT expiry guard.
    if (o.expiresAt && o.expiresAt.getTime() < now) {
      o.status = 'cancelled';
      o.rejectReason = 'GTT expired';
      await o.save();
      events.push({ userId: o.userId.toString(), kind: 'cancelled', order: o, reason: 'GTT expired' });
      continue;
    }

    // ── Stop trigger → convert to market/limit (real broker behaviour) ──
    if (o.type === 'sl' || o.type === 'sl-m') {
      if (o.triggerPrice == null) continue;
      const triggered =
        (o.side === 'buy' && currentPrice >= o.triggerPrice) ||
        (o.side === 'sell' && currentPrice <= o.triggerPrice);
      if (!triggered) continue;
      if (o.type === 'sl') {
        // Convert to a resting limit @ price; limit logic below handles the fill.
        o.type = 'limit';
        o.triggerPrice = undefined;
        await o.save();
      }
      // sl-m falls through and is treated as a market fill below.
    }

    // ── Cheap trigger check on the LTP we already have (no depth fetch yet) ──
    let isMarketFill = false; // true once an SL-M has triggered → fills at market
    if (o.type === 'limit') {
      if (o.price == null) continue;
      const fillable =
        (o.side === 'buy' && currentPrice <= o.price) ||
        (o.side === 'sell' && currentPrice >= o.price);
      if (!fillable) continue;
    } else {
      isMarketFill = true; // sl-m just triggered above
    }

    // ── Claim atomically (guard against a concurrent tick double-filling) ──
    const prevStatus = o.status;
    const claimed = await Order.findOneAndUpdate(
      { _id: o._id, status: prevStatus },
      { $set: { status: 'filling' } },
      { new: true },
    );
    if (!claimed) continue; // someone else took it

    const remaining = claimed.quantity - (claimed.filledQuantity || 0);

    // ── Size the fill from REAL available volume + price it off the book ──
    let sliceQty: number;
    let fillPrice: number;
    try {
      // Cache-only depth (no network on the matcher tick — keeps the price
      // loop fast and never stalls fills behind an upstream call).
      const dq = getDepthCached(sym);
      if (isMarketFill) {
        // Triggered SL-M behaves like a market order: fill the whole remainder
        // by walking the book (synthetic tail beyond the visible 5 levels).
        sliceQty = remaining;
        const levels = claimed.side === 'buy' ? dq?.sell : dq?.buy;
        fillPrice = dq && levels && levels.length
          ? walkBook(claimed.side, remaining, dq.ltp || currentPrice, levels, seg.segment, seg.isOption, isFuture).fillPrice
          : applySlippage({ side: claimed.side, quantity: remaining, ltp: currentPrice, segment: seg.segment, isOption: seg.isOption, isFuture }).fillPrice;
      } else {
        // LIMIT: this tick fills only the volume actually resting at prices that
        // satisfy the limit — buy consumes asks ≤ limit, sell consumes bids ≥ limit.
        const limit = claimed.price!;
        const raw = claimed.side === 'buy' ? dq?.sell : dq?.buy;
        // Sanity band around the trusted tick LTP — drop garbage depth levels
        // (wrong instrument / scale glitch) before sizing/pricing the slice.
        const lo = currentPrice * 0.5;
        const hi = currentPrice * 1.5;
        const acceptable = (raw || []).filter((l: { price: number; quantity: number }) =>
          l.price >= lo && l.price <= hi &&
          (claimed.side === 'buy' ? l.price <= limit : l.price >= limit),
        );
        const avail = availableQty(acceptable);
        if (avail >= lot) {
          // Lot-align the consumable real volume (at least one lot).
          const aligned = Math.max(lot, Math.floor(Math.min(remaining, avail) / lot) * lot);
          sliceQty = Math.min(aligned, remaining);
          const vwap = vwapOfLevels(acceptable, sliceQty);
          // Safety: never fill worse than the user's limit.
          fillPrice = claimed.side === 'buy' ? Math.min(vwap, limit) : Math.max(vwap, limit);
        } else {
          // < 1 lot resting at an acceptable price this tick (thin/stale book),
          // but the LTP says we're marketable — honor a synthetic slice at the
          // limit so the order doesn't stall.
          sliceQty = partialSlice(remaining, lot);
          fillPrice = claimed.side === 'buy' ? Math.min(limit, currentPrice) : Math.max(limit, currentPrice);
        }
      }
    } catch {
      // Depth unavailable → synthetic fallback (previous behaviour).
      sliceQty = partialSlice(remaining, lot);
      fillPrice = isMarketFill
        ? applySlippage({ side: claimed.side, quantity: remaining, ltp: currentPrice, segment: seg.segment, isOption: seg.isOption, isFuture }).fillPrice
        : (claimed.side === 'buy' ? Math.min(claimed.price!, currentPrice) : Math.max(claimed.price!, currentPrice));
    }

    try {
      const fill = await executeFill(claimed, fillPrice, sliceQty);
      events.push({ userId: claimed.userId.toString(), kind: 'filled', order: fill.order, fill });

      // IOC: cancel any unfilled remainder after this tick's fill.
      if (fill.order.status === 'partial' && claimed.validity === 'IOC') {
        fill.order.status = 'cancelled';
        fill.order.rejectReason = 'IOC: remainder cancelled';
        await fill.order.save();
        events.push({ userId: claimed.userId.toString(), kind: 'cancelled', order: fill.order, reason: 'IOC remainder' });
      }
    } catch (err: any) {
      events.push({ userId: claimed.userId.toString(), kind: 'rejected', order: claimed, reason: err.message });
    }
  }

  return events;
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
 *   totalValue      — equity NAV. For MARGIN instruments (futures, equity MIS)
 *                     the cost wasn't taken from cash (only margin was blocked),
 *                     so NAV = balance + marginUsed + unrealised P&L. For
 *                     CASH-FUNDED LONGS (option BUYs, CNC equity) the FULL cost
 *                     already left the wallet and marginUsed = 0, so their cost
 *                     basis must be added back (cost + unrealised = market value),
 *                     otherwise the holdings would vanish from NAV.
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
  // Cost basis of cash-funded LONG positions (option BUYs / CNC equity). The
  // premium/cost for these already left `virtualBalance` and they block no
  // margin, so it must be added back into NAV (see totalValue below).
  let cashFundedLongCost = 0;

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

      const seg = inferSegment(p.symbol);
      const cashFunded = seg.isOption || (seg.segment === 'EQ' && (p.product || 'CNC') === 'CNC');
      if (cashFunded && p.netQuantity > 0) {
        cashFundedLongCost += p.netQuantity * p.avgEntryPrice;
      }
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
    totalValue: user.virtualBalance + marginUsed + unrealisedPnL + cashFundedLongCost,
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
