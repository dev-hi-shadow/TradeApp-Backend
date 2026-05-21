import { Types } from 'mongoose';
import { TradingPlan } from '../models/TradingPlan';

export const DEFAULT_PLANS: Array<{
  name: string;
  description: string;
  rules: Record<string, any>;
}> = [
  {
    name: 'Swing Trading',
    description: 'Hold positions for several days to weeks, riding intermediate trends.',
    rules: { maxLossPercent: 3, targetPercent: 8, holdingDays: '3-15' },
  },
  {
    name: 'Scalping',
    description: 'Very short-term trades aiming for small, frequent profits.',
    rules: { maxLossPercent: 0.5, targetPercent: 1, holdingMinutes: '1-15' },
  },
  {
    name: 'Commodity Trading',
    description: 'Trade gold, silver, and other commodities based on macro signals.',
    rules: { maxLossPercent: 2, targetPercent: 5, instruments: ['GOLD', 'SILVER'] },
  },
  {
    name: 'Long-term Investing',
    description: 'Buy fundamentally strong stocks and hold for the long haul.',
    rules: { maxLossPercent: 15, targetPercent: 50, holdingMonths: '6+' },
  },
  {
    name: 'Options Simulation',
    description: 'Simulate option-like payoffs using cash positions.',
    rules: { maxLossPercent: 5, targetPercent: 20, expiryWeekly: true },
  },
];

export async function seedDefaultPlansForUser(userId: Types.ObjectId): Promise<void> {
  const existing = await TradingPlan.countDocuments({ userId });
  if (existing > 0) return;
  const docs = DEFAULT_PLANS.map((p) => ({ ...p, userId, status: 'active' as const }));
  await TradingPlan.insertMany(docs);
}
