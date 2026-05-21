import { Schema, model, Document, Types } from 'mongoose';

export interface ITradingPlan extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  description: string;
  rules: Record<string, any>;
  status: 'active' | 'inactive' | 'archived';
  createdAt: Date;
  updatedAt: Date;
}

const TradingPlanSchema = new Schema<ITradingPlan>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    rules: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['active', 'inactive', 'archived'], default: 'active' },
  },
  { timestamps: true }
);

export const TradingPlan = model<ITradingPlan>('TradingPlan', TradingPlanSchema);
