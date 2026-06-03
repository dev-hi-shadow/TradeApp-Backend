import { Schema, model, Document, Types } from 'mongoose';

export interface IChargeBreakup {
  brokerage: number;
  stt: number;
  exchangeTxn: number;
  sebi: number;
  stampDuty: number;
  dpCharges: number;
  gst: number;
  total: number;
}

export interface ITransaction extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  orderId: Types.ObjectId;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  charges?: IChargeBreakup;
  /** Realised P&L booked by THIS fill (0 for opens/adds; non-zero on reduce/close). */
  realisedPnL?: number;
  /** Signed wallet cash flow of this fill (− premium/notional on buy, + on sell). */
  cashImpact?: number;
  timestamp: Date;
}

const TransactionSchema = new Schema<ITransaction>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
  symbol: { type: String, required: true, uppercase: true, trim: true },
  side: { type: String, enum: ['buy', 'sell'], required: true },
  quantity: { type: Number, required: true },
  price: { type: Number, required: true },
  charges: {
    brokerage:   { type: Number, default: 0 },
    stt:         { type: Number, default: 0 },
    exchangeTxn: { type: Number, default: 0 },
    sebi:        { type: Number, default: 0 },
    stampDuty:   { type: Number, default: 0 },
    dpCharges:   { type: Number, default: 0 },
    gst:         { type: Number, default: 0 },
    total:       { type: Number, default: 0 },
  },
  realisedPnL: { type: Number, default: 0 },
  cashImpact:  { type: Number, default: 0 },
  timestamp: { type: Date, default: Date.now, index: true },
});

export const Transaction = model<ITransaction>('Transaction', TransactionSchema);
