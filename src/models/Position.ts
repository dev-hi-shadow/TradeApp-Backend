import { Schema, model, Document, Types } from 'mongoose';

export interface IPosition extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  symbol: string;
  netQuantity: number;
  avgEntryPrice: number;
  realisedPnL: number;
  /** Cash blocked as margin for this open position (refunded on close). */
  marginBlocked: number;
  /** Product type the position was opened with (drives margin rate + auto-square-off cron). */
  product: 'CNC' | 'MIS' | 'NRML';
  updatedAt: Date;
  createdAt: Date;
}

const PositionSchema = new Schema<IPosition>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    symbol: { type: String, required: true, uppercase: true, trim: true },
    netQuantity:   { type: Number, default: 0 },
    avgEntryPrice: { type: Number, default: 0 },
    realisedPnL:   { type: Number, default: 0 },
    marginBlocked: { type: Number, default: 0 },
    product:       { type: String, enum: ['CNC', 'MIS', 'NRML'], default: 'CNC', index: true },
  },
  { timestamps: true }
);

// One row per (user, symbol, product). Zerodha-style: a NIFTY24400CE MIS
// position is distinct from a NIFTY24400CE NRML position — different margin
// rate, different square-off rules, different P&L bucket.
PositionSchema.index({ userId: 1, symbol: 1, product: 1 }, { unique: true });

export const Position = model<IPosition>('Position', PositionSchema);
