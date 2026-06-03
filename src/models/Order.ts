import { Schema, model, Document, Types } from 'mongoose';

// market / limit as before, plus:
//   sl    = Stop-Loss LIMIT  — rests until LTP crosses triggerPrice, then
//           becomes a limit order at `price`.
//   sl-m  = Stop-Loss MARKET — rests until LTP crosses triggerPrice, then
//           fills at market (LTP + slippage).
export type OrderType = 'market' | 'limit' | 'sl' | 'sl-m';
export type OrderSide = 'buy' | 'sell';
// `partial` = some quantity filled, remainder still resting (partial fills).
export type OrderStatus = 'pending' | 'filling' | 'partial' | 'filled' | 'rejected' | 'cancelled';
export type OrderProduct = 'CNC' | 'MIS' | 'NRML';
// DAY  — rests for the session (default).
// IOC  — Immediate-Or-Cancel: fill what you can now, cancel the rest.
// GTT  — Good-Till-Triggered: rests across sessions until trigger or expiry.
export type OrderValidity = 'DAY' | 'IOC' | 'GTT';

export interface IOrder extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  symbol: string;
  type: OrderType;
  side: OrderSide;
  quantity: number;
  /** Limit price (for limit / sl). Undefined for market / sl-m. */
  price?: number;
  /** Trigger price for sl / sl-m — the LTP level that activates the order. */
  triggerPrice?: number;
  validity: OrderValidity;
  /** Cumulative quantity filled so far (supports partial fills). */
  filledQuantity: number;
  /** Volume-weighted average fill price across all (partial) fills. */
  avgFillPrice?: number;
  /** Back-compat alias kept in sync with avgFillPrice for existing consumers. */
  filledPrice?: number;
  status: OrderStatus;
  product?: OrderProduct;
  planId?: Types.ObjectId;
  /**
   * Bracket levels — when set, a PositionGuard (auto stop-loss / target exit) is
   * created automatically the moment THIS entry order fully fills. Lets a user
   * arm a stop-loss + target at entry time in one shot.
   */
  bracketStopLoss?: number;
  bracketTarget?: number;
  /**
   * Cumulative brokerage + statutory charges booked across all (partial) fills
   * of this order. Mirrors what was actually deducted from the wallet via the
   * Transaction ledger, so order history can display the cost without re-deriving.
   */
  charges?: {
    brokerage: number;
    stt: number;
    exchangeTxn: number;
    sebi: number;
    stampDuty: number;
    dpCharges: number;
    gst: number;
    total: number;
  };
  rejectReason?: string;
  /** For GTT: when the resting order auto-expires. */
  expiresAt?: Date;
  createdAt: Date;
  filledAt?: Date;
}

const OrderSchema = new Schema<IOrder>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
    type: { type: String, enum: ['market', 'limit', 'sl', 'sl-m'], required: true },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number },
    triggerPrice: { type: Number },
    validity: { type: String, enum: ['DAY', 'IOC', 'GTT'], default: 'DAY' },
    filledQuantity: { type: Number, default: 0 },
    avgFillPrice: { type: Number },
    filledPrice: { type: Number },
    status: {
      type: String,
      enum: ['pending', 'filling', 'partial', 'filled', 'rejected', 'cancelled'],
      default: 'pending',
      index: true,
    },
    product: { type: String, enum: ['CNC', 'MIS', 'NRML'], default: 'CNC', index: true },
    planId: { type: Schema.Types.ObjectId, ref: 'TradingPlan' },
    bracketStopLoss: { type: Number },
    bracketTarget: { type: Number },
    charges: {
      _id: false,
      type: {
        brokerage: { type: Number, default: 0 },
        stt: { type: Number, default: 0 },
        exchangeTxn: { type: Number, default: 0 },
        sebi: { type: Number, default: 0 },
        stampDuty: { type: Number, default: 0 },
        dpCharges: { type: Number, default: 0 },
        gst: { type: Number, default: 0 },
        total: { type: Number, default: 0 },
      },
      default: undefined,
    },
    rejectReason: { type: String },
    expiresAt: { type: Date },
    filledAt: { type: Date },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    // Expose the `id` virtual (string of _id) in JSON so REST list responses
    // (GET /api/orders) match the WS `serializeOrder` shape the frontend reads
    // (o.id) — otherwise modify/cancel send orderId: undefined.
    toJSON: { virtuals: true },
  }
);

OrderSchema.index({ userId: 1, status: 1 });

export const Order = model<IOrder>('Order', OrderSchema);
