import { Schema, model, Document, Types } from 'mongoose';

/**
 * A browser's Web Push subscription (one per device/browser per user).
 *
 * The `endpoint` is the push-service URL (FCM for Chrome) and is globally
 * unique — we key on it so re-subscribing the same browser upserts rather than
 * duplicating. `keys` hold the client's public encryption material that
 * web-push uses to encrypt the payload.
 */
export interface IPushSubscription extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
  createdAt: Date;
}

const PushSubscriptionSchema = new Schema<IPushSubscription>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const PushSubscription = model<IPushSubscription>('PushSubscription', PushSubscriptionSchema);
