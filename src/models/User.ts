import { Schema, model, Document, Types } from 'mongoose';
import bcrypt from 'bcryptjs';
import { env } from '../config/env';

export type UserRole = 'user' | 'admin';

export interface IUser extends Document {
  _id: Types.ObjectId;
  username: string;
  email: string;
  password: string;
  virtualBalance: number;
  role: UserRole;
  createdAt: Date;
  comparePassword(plain: string): Promise<boolean>;
}

const UserSchema = new Schema<IUser>(
  {
    username: { type: String, required: true, unique: true, trim: true, minlength: 3 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, minlength: 6 },
    virtualBalance: { type: Number, default: env.DEFAULT_BALANCE },
    role: { type: String, enum: ['user', 'admin'], default: 'user', index: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

UserSchema.methods.comparePassword = async function (plain: string): Promise<boolean> {
  return bcrypt.compare(plain, this.password);
};

export const User = model<IUser>('User', UserSchema);
