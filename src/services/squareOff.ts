/**
 * Intraday-square-off cron.
 *
 * Runs every minute; when IST clock crosses the relevant cut-off it scans for
 * still-open MIS positions and closes them at the LTP from Angel One.
 *
 *   ┌──────────────────────────┬─────────────────────┐
 *   │ Segment                  │ Cut-off time (IST)  │
 *   ├──────────────────────────┼─────────────────────┤
 *   │ MIS Equity (NSE/BSE)     │ 15:20               │
 *   │ MIS F&O Index / Stock    │ 15:25               │
 *   │ MIS Commodity (MCX)      │ 23:25               │
 *   └──────────────────────────┴─────────────────────┘
 *
 * Square-off generates a market-side-flip order, fills it at the current
 * LTP, releases margin, and emits an `orderFilled` event to the user via
 * the existing WebSocket pipeline.
 */
import { Order } from '../models/Order';
import { Position } from '../models/Position';
import { executeFill, inferSegment, marketFillPrice } from './orderEngine';
import { fetchQuotes } from './marketData';

// IST minute-of-day cut-offs.
const CUTOFFS = {
  EQ:        { hour: 15, minute: 20, label: 'Equity MIS' },
  FNO:       { hour: 15, minute: 25, label: 'F&O MIS' },
  COMMODITY: { hour: 23, minute: 25, label: 'Commodity MIS' },
};

function istMinuteOfDay(now = new Date()): number {
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(istMs);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

function isWeekend(now = new Date()): boolean {
  const istMs = now.getTime() + 5.5 * 60 * 60 * 1000;
  const dow = new Date(istMs).getUTCDay();
  return dow === 0 || dow === 6;
}

// Avoid double-firing within the same minute on a long-running process.
let lastFiredMin = -1;

// Use the SAME segment classifier as the order engine so square-off timing
// matches how the position was margined. Previously this had a hand-rolled
// copy that omitted ZINC/LEAD/ALUMINIUM, so those commodity MIS positions were
// classified FNO and squared off at 15:25 instead of 23:25 — a real bug.
function inferSegmentOfSymbol(sym: string): 'EQ' | 'FNO' | 'COMMODITY' {
  const seg = inferSegment(sym).segment;
  // Square-off only buckets into these three; CURRENCY (not auto-squared here)
  // falls back to the 15:25 F&O window.
  return seg === 'COMMODITY' ? 'COMMODITY' : seg === 'EQ' ? 'EQ' : 'FNO';
}

async function squareOff(segments: Array<'EQ' | 'FNO' | 'COMMODITY'>): Promise<void> {
  // All open MIS positions in the targeted segments
  const positions = await Position.find({ product: 'MIS', netQuantity: { $ne: 0 } });
  const targets = positions.filter((p) => segments.includes(inferSegmentOfSymbol(p.symbol)));
  if (!targets.length) return;

  console.log(`[squareOff] ${targets.length} MIS positions to close (${segments.join(',')})`);

  // Quote everything once (so we close at a consistent LTP)
  const quotes = await fetchQuotes(targets.map((p) => p.symbol));
  const px = new Map(quotes.map((q) => [q.displaySymbol.toUpperCase(), q.price]));

  for (const p of targets) {
    const ltp = px.get(p.symbol.toUpperCase());
    if (!ltp) {
      console.warn(`[squareOff] no LTP for ${p.symbol}, skipping`);
      continue;
    }
    // Flip side: long → sell, short → buy
    const flipSide = p.netQuantity > 0 ? 'sell' : 'buy';
    const qty = Math.abs(p.netQuantity);

    try {
      const order = await Order.create({
        userId: p.userId,
        symbol: p.symbol,
        type: 'market',
        side: flipSide,
        quantity: qty,
        product: 'MIS',
        status: 'filling',
        rejectReason: undefined,
      });
      const fillPx = await marketFillPrice(p.symbol, flipSide, qty, ltp);
      await executeFill(order, fillPx);
      console.log(`[squareOff] closed ${p.symbol} qty=${qty} @ ${fillPx.toFixed(2)}`);
    } catch (err: any) {
      console.error(`[squareOff] ${p.symbol} failed:`, err.message || err);
    }
  }
}

export function startSquareOffCron(): void {
  setInterval(async () => {
    try {
      if (isWeekend()) return;
      const m = istMinuteOfDay();
      if (m === lastFiredMin) return;

      const eqMin       = CUTOFFS.EQ.hour        * 60 + CUTOFFS.EQ.minute;
      const fnoMin      = CUTOFFS.FNO.hour       * 60 + CUTOFFS.FNO.minute;
      const commodMin   = CUTOFFS.COMMODITY.hour * 60 + CUTOFFS.COMMODITY.minute;

      if (m === eqMin) {
        lastFiredMin = m;
        console.log('[squareOff] firing Equity MIS cut-off (15:20 IST)');
        await squareOff(['EQ']);
      } else if (m === fnoMin) {
        lastFiredMin = m;
        console.log('[squareOff] firing F&O MIS cut-off (15:25 IST)');
        await squareOff(['FNO']);
      } else if (m === commodMin) {
        lastFiredMin = m;
        console.log('[squareOff] firing Commodity MIS cut-off (23:25 IST)');
        await squareOff(['COMMODITY']);
      }
    } catch (err: any) {
      console.error('[squareOff] cron error:', err.message || err);
    }
  }, 30_000); // 30 s — catches both minutes inside any single market-minute window
  console.log('[squareOff] cron started — checks every 30s for IST cut-offs');
}
