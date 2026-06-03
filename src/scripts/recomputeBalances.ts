/**
 * One-time balance recompute.
 *
 *   $ npm run recompute            # apply the fix to every un-corrected user
 *   $ npm run recompute -- --dry   # preview only; writes nothing
 *
 * Corrects wallets for the cash-settled P&L double-count + CNC phantom-margin
 * bugs. Idempotent: each user is flagged (balanceRecalcV1) once corrected, so
 * re-running is safe. See services/balanceRecompute.ts for the math.
 */
import mongoose from 'mongoose';
import { env } from '../config/env';
import { recomputeAllBalances } from '../services/balanceRecompute';

async function main() {
  const dryRun = process.argv.includes('--dry');
  await mongoose.connect(env.MONGO_URI);
  console.log(`[recompute] connected to ${env.MONGO_URI}`);
  console.log(`[recompute] mode: ${dryRun ? 'DRY-RUN (no writes)' : 'APPLY'}\n`);

  const results = await recomputeAllBalances(dryRun);

  let changed = 0;
  let totalDelta = 0;
  for (const r of results) {
    if (r.skipped) continue;
    if (Math.abs(r.delta) > 0.005 || r.cncPositionsFixed > 0) {
      changed++;
      totalDelta += r.delta;
      console.log(
        `${r.email.padEnd(32)} ₹${r.oldBalance.toFixed(2).padStart(13)} → ₹${r.newBalance.toFixed(2).padStart(13)}  ` +
          `(Δ ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)}  | −dupPnL ${r.doubleCountedPnL.toFixed(2)}  +cncMargin ${r.phantomCncMargin.toFixed(2)}  cncFixed ${r.cncPositionsFixed})`,
      );
    }
  }

  console.log(
    `\n[recompute] ${dryRun ? 'would update' : 'updated'} ${changed} user(s) ` +
      `of ${results.length} scanned. Net Δ across all: ₹${totalDelta.toFixed(2)}.`,
  );
  if (dryRun) console.log('[recompute] DRY-RUN — nothing was written. Re-run without --dry to apply.');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('[recompute] fatal:', err);
  process.exit(1);
});
