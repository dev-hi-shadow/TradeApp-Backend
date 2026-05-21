/**
 * Price alert.
 *
 * Trigger conditions:
 *   • above   — fires when price CROSSES upward through `value`
 *   • below   — fires when price CROSSES downward through `value`
 *   • pctUp   — fires when price has moved up   ≥ `value` % from baseline
 *   • pctDown — fires when price has moved down ≥ `value` % from baseline
 *
 * Frequency rules:
 *   • once  — fires a single time then status → 'triggered'
 *   • every — fires every cross with `cooldownSeconds` gap between fires
 *   • daily — fires at most once per IST day (resets at midnight IST)
 */
import { Schema, model, Document, Types } from 'mongoose';

export type AlertType = 'above' | 'below' | 'pctUp' | 'pctDown';
export type AlertFrequency = 'once' | 'every' | 'daily';
export type AlertStatus = 'active' | 'triggered' | 'paused';

export interface IAlert extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  symbol: string;
  type: AlertType;
  value: number;
  baselinePrice?: number; // captured at creation for pctUp/pctDown
  frequency: AlertFrequency;
  status: AlertStatus;
  cooldownSeconds: number;
  lastTriggeredAt?: Date;
  triggerCount: number;
  note?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AlertSchema = new Schema<IAlert>(
  {
    userId:   { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    symbol:   { type: String, required: true, uppercase: true, trim: true, index: true },
    type:     { type: String, enum: ['above', 'below', 'pctUp', 'pctDown'], required: true },
    value:    { type: Number, required: true },
    baselinePrice:   { type: Number },
    frequency:       { type: String, enum: ['once', 'every', 'daily'], default: 'once' },
    status:          { type: String, enum: ['active', 'triggered', 'paused'], default: 'active', index: true },
    cooldownSeconds: { type: Number, default: 300 },
    lastTriggeredAt: { type: Date },
    triggerCount:    { type: Number, default: 0 },
    note:            { type: String, default: '', maxlength: 200 },
  },
  { timestamps: true }
);

AlertSchema.index({ symbol: 1, status: 1 });
AlertSchema.index({ userId: 1, status: 1 });

export const Alert = model<IAlert>('Alert', AlertSchema);
