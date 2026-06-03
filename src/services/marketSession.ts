/**
 * Market-session authority (IST). Single source of truth for "can this segment
 * be traded right now?" — used to BLOCK order placement outside market hours and
 * to GATE the resting-order matcher + position guards so SL/target/limit levels
 * never fire on stale post-close prices (they fire at the next open instead).
 *
 *   ┌───────────────────────────┬──────────────┬───────────────────────────┐
 *   │ Exchange / segment        │ Trading hours│ Notes                     │
 *   ├───────────────────────────┼──────────────┼───────────────────────────┤
 *   │ NSE/BSE Equity (EQ)       │ 09:15–15:30  │ pre-open 09:00–09:15 is    │
 *   │ NSE/BSE F&O   (FNO)       │ 09:15–15:30  │ NOT tradable here          │
 *   │ MCX Commodity (COMMODITY) │ 09:00–23:30  │ non-agri (GOLD/CRUDE/…)    │
 *   │ NSE Currency  (CURRENCY)  │ 09:00–17:00  │                           │
 *   └───────────────────────────┴──────────────┴───────────────────────────┘
 *
 * Weekends are closed. Exchange trading holidays can be added to HOLIDAYS_IST
 * (YYYY-MM-DD) without touching the logic.
 *
 * Pure module (no orderEngine import) to avoid an import cycle — callers pass the
 * already-classified `Segment` (from orderEngine.inferSegment).
 */
import type { Segment } from './charges';

export type Exchange = 'NSE' | 'MCX' | 'CDS';

/** Trading window per exchange, as IST minute-of-day [openMin, closeMin]. */
const HOURS: Record<Exchange, { open: number; close: number; label: string; openLabel: string; closeLabel: string }> = {
  NSE: { open: 9 * 60 + 15, close: 15 * 60 + 30, label: 'NSE/BSE', openLabel: '9:15 AM', closeLabel: '3:30 PM' },
  MCX: { open: 9 * 60,      close: 23 * 60 + 30, label: 'MCX',     openLabel: '9:00 AM', closeLabel: '11:30 PM' },
  CDS: { open: 9 * 60,      close: 17 * 60,      label: 'NSE Currency', openLabel: '9:00 AM', closeLabel: '5:00 PM' },
};

/**
 * Exchange trading holidays (IST, 'YYYY-MM-DD') — full-day market closures.
 *
 * ⚠️ Only CERTAIN fixed-date national holidays + Good Friday are listed below.
 * A WRONG holiday would falsely BLOCK trading on a real session, so festival
 * dates (Holi, Eid, Dussehra, Diwali, Guru Nanak Jayanti, etc.) are intentionally
 * omitted until confirmed — fill them each year from NSE's & MCX's official
 * "trading holidays" circular (they differ slightly between exchanges).
 */
const HOLIDAYS_IST = new Set<string>([
  // 2026 — certain national holidays
  '2026-01-26', // Republic Day
  '2026-04-03', // Good Friday
  '2026-05-01', // Maharashtra Day (NSE/BSE equity + F&O)
  '2026-08-15', // Independence Day (Sat — also weekend)
  '2026-10-02', // Gandhi Jayanti
  '2026-12-25', // Christmas
  // TODO(2026): add festival holidays from the official NSE/MCX circular.
]);

export function exchangeForSegment(segment: Segment): Exchange {
  if (segment === 'COMMODITY') return 'MCX';
  if (segment === 'CURRENCY') return 'CDS';
  return 'NSE'; // EQ + FNO trade on the NSE/BSE 9:15–15:30 clock
}

/** IST calendar parts for a given instant. */
function istParts(now: Date): { minOfDay: number; dow: number; ymd: string } {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const minOfDay = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const dow = ist.getUTCDay(); // 0 Sun … 6 Sat
  const ymd = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-${String(ist.getUTCDate()).padStart(2, '0')}`;
  return { minOfDay, dow, ymd };
}

function isTradingDay(now: Date): boolean {
  const { dow, ymd } = istParts(now);
  if (dow === 0 || dow === 6) return false;
  if (HOLIDAYS_IST.has(ymd)) return false;
  return true;
}

/** Is this segment tradable RIGHT NOW (IST)? */
export function isTradingOpen(segment: Segment, now: Date = new Date()): boolean {
  if (!isTradingDay(now)) return false;
  const h = HOURS[exchangeForSegment(segment)];
  const { minOfDay } = istParts(now);
  // Strictly inside [open, close): open is inclusive, close exclusive. So at
  // exactly 15:30 the market is treated as closed (matches "after close").
  return minOfDay >= h.open && minOfDay < h.close;
}

export interface MarketStatus {
  open: boolean;
  exchange: Exchange;
  /** Human label for when trading (re)opens, e.g. "9:15 AM". */
  opensAt: string;
  closesAt: string;
  /** One-line reason suitable for a user-facing error/toast. */
  reason: string;
}

export function marketStatus(segment: Segment, now: Date = new Date()): MarketStatus {
  const exchange = exchangeForSegment(segment);
  const h = HOURS[exchange];
  const open = isTradingOpen(segment, now);
  let reason: string;
  if (open) {
    reason = `${h.label} is open`;
  } else {
    const { minOfDay } = istParts(now);
    const tradingDay = isTradingDay(now);
    if (tradingDay && minOfDay < h.open) {
      reason = `${h.label} opens at ${h.openLabel}`;
    } else if (tradingDay && minOfDay >= h.close) {
      reason = `${h.label} is closed for the day — opens ${h.openLabel} next trading day`;
    } else {
      reason = `${h.label} is closed — opens ${h.openLabel} next trading day`;
    }
  }
  return { open, exchange, opensAt: h.openLabel, closesAt: h.closeLabel, reason };
}
