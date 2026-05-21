import mongoose from 'mongoose';
import { env } from './env';

export async function connectDB(): Promise<void> {
  mongoose.set('strictQuery', true);
  try {
    await mongoose.connect(env.MONGO_URI);
    console.log('[db] Connected to MongoDB:', env.MONGO_URI);
  } catch (err) {
    console.error('[db] Connection error:', err);
    process.exit(1);
  }
}
