import { Schema, model, Document, Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import { env } from '../config/env';

export type UserRole = 'user' | 'admin';

export interface IUser extends Document {
  _id: Types.ObjectId;
  username: string;
  email: string;
  /** Optional: Google-only accounts have no local password. */
  password?: string;
  virtualBalance: number;
  role: UserRole;
  createdAt: Date;
  /** Google account id (`sub` from the verified ID token), when linked. */
  googleId?: string;
  /** Profile picture URL from Google (cosmetic). */
  avatarUrl?: string;
  /** True once the email address is confirmed (Google logins are pre-verified). */
  emailVerified: boolean;
  /** sha256 hash of the active email-verification token. */
  emailVerifyTokenHash?: string;
  /** Expiry of the active email-verification token. */
  emailVerifyExpires?: Date;
  /** sha256 hash of the active password-reset token (raw token is emailed, never stored). */
  resetPasswordTokenHash?: string;
  /** Expiry of the active reset token. */
  resetPasswordExpires?: Date;
  /** When the password was last changed — lets us reject reset links issued earlier. */
  passwordChangedAt?: Date;
  /** Set once the v1 balance recompute (cash-settled P&L double-count + CNC
   *  phantom-margin correction) has been applied — makes the fix idempotent. */
  balanceRecalcV1?: boolean;
  comparePassword(plain: string): Promise<boolean>;
}

const UserSchema = new Schema<IUser>(
  {
    username: { type: String, required: true, unique: true, trim: true, minlength: 3 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    // Optional so Google-only accounts (no local password) are valid. The
    // register route still enforces a password for the email/password path.
    password: { type: String, minlength: 6, select: false },
    virtualBalance: { type: Number, default: env.DEFAULT_BALANCE },
    role: { type: String, enum: ['user', 'admin'], default: 'user', index: true },
    googleId: { type: String, index: true, sparse: true },
    avatarUrl: { type: String },
    emailVerified: { type: Boolean, default: false },
    // `select: false` keeps these out of normal reads (e.g. /me) unless
    // explicitly requested — they're security material, not profile data.
    emailVerifyTokenHash: { type: String, select: false },
    emailVerifyExpires: { type: Date, select: false },
    resetPasswordTokenHash: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },
    passwordChangedAt: { type: Date, select: false },
    balanceRecalcV1: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

UserSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  // Stamp the change so any reset link issued before this moment is invalid.
  // Skip on the very first save (registration) — there's nothing to invalidate.
  if (!this.isNew) this.passwordChangedAt = new Date();
  next();
});

UserSchema.methods.comparePassword = async function (plain: string): Promise<boolean> {
  // Google-only accounts have no local password — never match.
  if (!this.password) return false;
  return bcrypt.compare(plain, this.password);
};

export const User = model<IUser>('User', UserSchema);
