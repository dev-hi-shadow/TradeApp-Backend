/**
 * Append-only ledger of admin-driven balance adjustments.
 *
 * Every entry records:
 *  - user receiving / losing margin
 *  - admin who made the change
 *  - amount (+credit / -debit)
 *  - balance snapshot before/after
 *  - free-form note
 */
import { Schema, model, Document, Types } from 'mongoose';

export interface IMarginLedger extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  adminId: Types.ObjectId;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  note?: string;
  createdAt: Date;
}

const MarginLedgerSchema = new Schema<IMarginLedger>(
  {
    userId:        { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    adminId:       { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amount:        { type: Number, required: true },
    balanceBefore: { type: Number, required: true },
    balanceAfter:  { type: Number, required: true },
    note:          { type: String, default: '' },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const MarginLedger = model<IMarginLedger>('MarginLedger', MarginLedgerSchema);
