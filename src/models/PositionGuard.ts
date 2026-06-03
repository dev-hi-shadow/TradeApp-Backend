import { Schema, model, Document, Types } from 'mongoose';

/**
 * Per-position risk guard — the "SL on P&L" feature.
 *
 * Attaches an automatic stop-loss / target / trailing-stop to an OPEN
 * position (keyed by user + symbol + product, mirroring the Position key).
 * The price loop evaluates active guards every tick and squares the position
 * off at market when a level is hit — server-side, so it fires even while the
 * user is disconnected (same guarantee as resting limit/SL orders).
 *
 * All levels are stored as PRICES (canonical), so the tick check is a trivial
 * comparison. The UI converts a user's "₹ P&L" / "% P&L" intent into a price
 * using the position's avgEntryPrice and quantity before saving.
 *
 *   • stopLossPrice  — exit to CAP A LOSS.  Long: trigger when LTP ≤ SL.
 *                                            Short: trigger when LTP ≥ SL.
 *   • targetPrice    — exit to BOOK PROFIT. Long: trigger when LTP ≥ target.
 *                                            Short: trigger when LTP ≤ target.
 *   • trailingAmount — per-unit ₹ distance for a trailing stop. As price moves
 *                      favourably the anchor ratchets; exit when price retraces
 *                      `trailingAmount` from the best (trailAnchor).
 */
export interface IPositionGuard extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  symbol: string;
  product: 'CNC' | 'MIS' | 'NRML';
  stopLossPrice?: number;
  targetPrice?: number;
  trailingAmount?: number;
  /** Best price seen since the trailing stop was set (high for long, low for short). */
  trailAnchor?: number;
  createdAt: Date;
  updatedAt: Date;
}

const PositionGuardSchema = new Schema<IPositionGuard>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
    product: { type: String, enum: ['CNC', 'MIS', 'NRML'], required: true },
    stopLossPrice: { type: Number },
    targetPrice: { type: Number },
    trailingAmount: { type: Number },
    trailAnchor: { type: Number },
  },
  { timestamps: true },
);

// One guard per (user, symbol, product) — matches the Position uniqueness.
PositionGuardSchema.index({ userId: 1, symbol: 1, product: 1 }, { unique: true });

export const PositionGuard = model<IPositionGuard>('PositionGuard', PositionGuardSchema);
