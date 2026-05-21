import { Schema, model, Document, Types } from 'mongoose';

export interface IWatchlist extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  symbols: string[];
  updatedAt: Date;
  createdAt: Date;
}

const WatchlistSchema = new Schema<IWatchlist>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    symbols: { type: [String], default: [] },
  },
  { timestamps: true }
);

export const Watchlist = model<IWatchlist>('Watchlist', WatchlistSchema);
