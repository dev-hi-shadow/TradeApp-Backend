/**
 * IST (Asia/Kolkata) calendar-day helpers for trade history / per-day P&L.
 * Trading days are reckoned in IST, so "today's trades" and date filters must
 * snap to IST midnight — not the server's local/UTC midnight.
 */
import moment from 'moment-timezone';

const IST = 'Asia/Kolkata';

export interface DayRange {
  from: number; // inclusive epoch ms (IST 00:00)
  to: number;   // exclusive epoch ms (next IST 00:00)
  date: string; // 'YYYY-MM-DD' (IST)
  label: string; // 'DD MMM YYYY'
}

/** IST day range for a 'YYYY-MM-DD' date, or today when omitted/invalid. */
export function istDayRange(date?: string): DayRange {
  const m = date && moment.tz(date, 'YYYY-MM-DD', true, IST).isValid()
    ? moment.tz(date, 'YYYY-MM-DD', IST)
    : moment.tz(IST);
  const start = m.clone().startOf('day');
  const end = start.clone().add(1, 'day');
  return {
    from: start.valueOf(),
    to: end.valueOf(),
    date: start.format('YYYY-MM-DD'),
    label: start.format('DD MMM YYYY'),
  };
}

/** Today's IST date string, 'YYYY-MM-DD'. */
export function istToday(): string {
  return moment.tz(IST).format('YYYY-MM-DD');
}

/**
 * Resolve a date range from request query: explicit ?from=&to= (epoch ms) wins,
 * else ?date=YYYY-MM-DD (single IST day), else null (no date filter).
 */
export function rangeFromQuery(q: any): { from: number; to: number } | null {
  const fromMs = q?.from != null ? parseInt(String(q.from), 10) : NaN;
  const toMs = q?.to != null ? parseInt(String(q.to), 10) : NaN;
  if (Number.isFinite(fromMs) && Number.isFinite(toMs)) return { from: fromMs, to: toMs };
  if (q?.date) {
    const r = istDayRange(String(q.date));
    return { from: r.from, to: r.to };
  }
  return null;
}
