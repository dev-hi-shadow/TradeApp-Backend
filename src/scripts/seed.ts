/**
 * One-shot seed script.
 *
 *   $ npm run seed
 *
 * Creates (or refreshes) a demo account so reviewers can log in immediately:
 *   email:    demo@example.com
 *   username: demo
 *   password: demo123
 *
 * Watchlist:  NIFTY, SENSEX, GOLD, RELIANCE, TCS, INFY
 * Plans:      the 5 default trading plans defined in plansSeeder.ts
 *
 * Safe to re-run — uses upsert semantics.
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { User } from '../models/User';
import { Watchlist } from '../models/Watchlist';
import { TradingPlan } from '../models/TradingPlan';
import { Order } from '../models/Order';
import { Position } from '../models/Position';
import { Transaction } from '../models/Transaction';
import { DEFAULT_PLANS, seedDefaultPlansForUser } from '../services/plansSeeder';

const DEMO = {
  username: 'demo',
  email: 'demo@example.com',
  password: 'demo123',
  role: 'user' as const,
};

const ADMIN = {
  username: 'admin',
  email: 'admin@tradeapp.com',
  password: 'tradeapp@123',
  role: 'admin' as const,
};

const DEMO_WATCHLIST = [
  'NIFTY', 'SENSEX', 'BANKNIFTY', 'GOLD', 'SILVER', 'CRUDEOIL',
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK',
];

async function main() {
  await mongoose.connect(env.MONGO_URI);
  console.log('[seed] connected to', env.MONGO_URI);

  // ---- Admin user ----
  let admin = await User.findOne({ email: ADMIN.email });
  if (!admin) {
    admin = await User.create({ ...ADMIN, virtualBalance: 0 });
    console.log('[seed] created admin user', admin.email);
  } else {
    admin.role = 'admin';
    admin.password = ADMIN.password;
    await admin.save();
    console.log('[seed] refreshed admin user', admin.email);
  }

  // ---- Demo trader ----
  let user = await User.findOne({ email: DEMO.email });
  if (!user) {
    user = await User.create({ ...DEMO, virtualBalance: env.DEFAULT_BALANCE });
    console.log('[seed] created demo user', user.email);
  } else {
    user.virtualBalance = env.DEFAULT_BALANCE;
    user.role = 'user';
    // Bcrypt pre-save only re-hashes when password is modified;
    // re-set explicitly so the password matches what we advertise.
    user.password = DEMO.password;
    await user.save();
    console.log('[seed] refreshed demo user', user.email);
  }

  // Clear any prior trading state so the demo always starts clean
  await Promise.all([
    Order.deleteMany({ userId: user._id }),
    Position.deleteMany({ userId: user._id }),
    Transaction.deleteMany({ userId: user._id }),
  ]);

  await Watchlist.findOneAndUpdate(
    { userId: user._id },
    { symbols: DEMO_WATCHLIST },
    { upsert: true, new: true }
  );
  console.log('[seed] watchlist:', DEMO_WATCHLIST.join(', '));

  // Seed the 5 default plans only if the user has none — otherwise top up
  // any that are missing by name (idempotent).
  await seedDefaultPlansForUser(user._id);
  for (const p of DEFAULT_PLANS) {
    await TradingPlan.findOneAndUpdate(
      { userId: user._id, name: p.name },
      { $setOnInsert: { ...p, userId: user._id, status: 'active' } },
      { upsert: true, new: true }
    );
  }
  const planCount = await TradingPlan.countDocuments({ userId: user._id });
  console.log(`[seed] plans: ${planCount} active`);

  console.log('\n[seed] DONE');
  console.log('  Trader login:');
  console.log(`    email:    ${DEMO.email}`);
  console.log(`    password: ${DEMO.password}`);
  console.log('  Admin login:');
  console.log(`    email:    ${ADMIN.email}`);
  console.log(`    password: ${ADMIN.password}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[seed] fatal:', err);
  process.exit(1);
});
