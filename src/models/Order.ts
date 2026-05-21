import { Schema, model, Document, Types } from 'mongoose';

export type OrderType = 'market' | 'limit';
export type OrderSide = 'buy' | 'sell';
export type OrderStatus = 'pending' | 'filling' | 'filled' | 'rejected' | 'cancelled';
export type OrderProduct = 'CNC' | 'MIS' | 'NRML';

export interface IOrder extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  symbol: string;
  type: OrderType;
  side: OrderSide;
  quantity: number;
  price?: number;
  filledPrice?: number;
  status: OrderStatus;
  product?: OrderProduct;
  planId?: Types.ObjectId;
  rejectReason?: string;
  createdAt: Date;
  filledAt?: Date;
}

const OrderSchema = new Schema<IOrder>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
    type: { type: String, enum: ['market', 'limit'], required: true },
    side: { type: String, enum: ['buy', 'sell'], required: true },
    quantity: { type: Number, required: true, min: 1 },
    price: { type: Number },
    filledPrice: { type: Number },
    status: {
      type: String,
      enum: ['pending', 'filling', 'filled', 'rejected', 'cancelled'],
      default: 'pending',
      index: true,
    },
    product: { type: String, enum: ['CNC', 'MIS', 'NRML'], default: 'CNC', index: true },
    planId: { type: Schema.Types.ObjectId, ref: 'TradingPlan' },
    rejectReason: { type: String },
    filledAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

OrderSchema.index({ userId: 1, status: 1 });

export const Order = model<IOrder>('Order', OrderSchema);
