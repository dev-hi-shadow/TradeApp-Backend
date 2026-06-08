/**
 * Bridges the price loop's desired symbol union to the Angel SmartWebSocketV2
 * feed: resolves each display symbol to its {exchange, token} (via Angel's
 * cached resolver) and hands the feed the full desired set, which it diffs into
 * sub/unsubscribe deltas.
 *
 * Self-throttled and change-gated: it only does work when the symbol set
 * actually changes (and at most every THROTTLE_MS), so calling it on every
 * 1.5s tick is cheap.
 */
import { angel } from './angelOne';
import { angelFeed, exchangeTypeFor } from './angelFeed';

const THROTTLE_MS = 2000;
let lastKey = '';
let lastRunAt = 0;
let running = false;

export async function syncFeedSubscriptions(symbols: string[]): Promise<void> {
  const key = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).sort().join(',');
  const now = Date.now();
  if (running) return;
  if (key === lastKey && now - lastRunAt < 30_000) return; // unchanged → occasional refresh only
  if (now - lastRunAt < THROTTLE_MS && key === lastKey) return;
  running = true;
  lastRunAt = now;
  lastKey = key;
  try {
    const infos = [];
    for (const sym of new Set(symbols.map((s) => s.toUpperCase()))) {
      const r = await angel.resolve(sym);
      if (!r) continue;
      const exchangeType = exchangeTypeFor(r.exchange);
      if (exchangeType == null) continue;
      infos.push({ displaySymbol: sym, exchange: r.exchange, exchangeType, token: r.token });
    }
    angelFeed.setDesired(infos);
  } finally {
    running = false;
  }
}
