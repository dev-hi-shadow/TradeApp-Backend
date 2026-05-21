/**
 * Append-only log of every time an alert fired. Used to drive the
 * "Recently triggered" tab and any future audit/notification analytics.
 */
import { Schema, model, Document, Types } from 'mongoose';

export interface IAlertEvent extends Document {
  _id: Types.ObjectId;
  alertId: Types.ObjectId;
  userId: Types.ObjectId;
  symbol: string;
  type: 'above' | 'below' | 'pctUp' | 'pctDown';
  triggerPrice: number;
  conditionValue: number;
  baselinePrice?: number;
  note?: string;
  triggeredAt: Date;
}

const AlertEventSchema = new Schema<IAlertEvent>({
  alertId:        { type: Schema.Types.ObjectId, ref: 'Alert', required: true, index: true },
  userId:         { type: Schema.Types.ObjectId, ref: 'User',  required: true, index: true },
  symbol:         { type: String, required: true, uppercase: true, trim: true },
  type:           { type: String, enum: ['above', 'below', 'pctUp', 'pctDown'], required: true },
  triggerPrice:   { type: Number, required: true },
  conditionValue: { type: Number, required: true },
  baselinePrice:  { type: Number },
  note:           { type: String, default: '' },
  triggeredAt:    { type: Date, default: Date.now, index: true },
});

export const AlertEvent = model<IAlertEvent>('AlertEvent', AlertEventSchema);
