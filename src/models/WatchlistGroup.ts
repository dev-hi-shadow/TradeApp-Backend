import { Schema, model, Document, Types } from 'mongoose';

/**
 * A NAMED watchlist (Groww/Dhan style — "Watchlist 1", "Banking", etc.).
 * A user can have several; the legacy single `Watchlist` is kept separately to
 * drive the always-on index/ticker subscriptions, so this is purely additive.
 */
export interface IWatchlistGroup extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  name: string;
  symbols: string[];
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const WatchlistGroupSchema = new Schema<IWatchlistGroup>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    symbols: { type: [String], default: [] },
    order: { type: Number, default: 0 },
  },
  { timestamps: true, toJSON: { virtuals: true } },
);

WatchlistGroupSchema.index({ userId: 1, order: 1 });

export const WatchlistGroup = model<IWatchlistGroup>('WatchlistGroup', WatchlistGroupSchema);
