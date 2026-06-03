import { Schema, model, Document, Types } from 'mongoose';

/**
 * A refresh-token session — one row per logged-in device/browser. The raw
 * refresh token is only ever held by the client; we store nothing but its
 * sha256 hash, so a DB leak can't be replayed into live sessions.
 *
 * Rotation: every successful /auth/refresh revokes the presented token and
 * issues a fresh one (revokedAt + replacedBy form an audit chain). Reuse of an
 * already-revoked token is treated as theft → the whole chain is killed.
 */
export interface ISession extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  tokenHash: string;
  userAgent?: string;
  ip?: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt?: Date;
  replacedBy?: string; // tokenHash of the rotated-in successor
}

const SessionSchema = new Schema<ISession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    userAgent: { type: String },
    ip: { type: String },
    lastUsedAt: { type: Date, default: Date.now },
    // TTL index: Mongo auto-purges sessions once they pass their expiry.
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
    revokedAt: { type: Date },
    replacedBy: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const Session = model<ISession>('Session', SessionSchema);
