/**
 * Tiny Redis (Valkey-compatible) cache facade with graceful in-memory fallback.
 *
 * Used to absorb burst load on Angel One / Yahoo when:
 *   • the user buys an option (orderEngine refetches the contract LTP), and
 *   • the option-chain 5s poll fires for 20+ strikes
 * land within the same 100 ms window. Without this, the second call competes
 * with the first, Angel 403s once, and the chain renders as 0.00 across the
 * board until the 5s breaker closes.
 *
 * Anything that goes through here is JSON-encoded. Keys are short, prefixed.
 * If Redis isn't reachable we silently degrade to an in-process Map with
 * identical semantics — the app keeps running, just without cross-process
 * dedup between (rare) multi-instance deploys.
 */
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const KEY_PREFIX = 'paper-trading:';

interface MemEntry { value: string; expiresAt: number }
const memFallback = new Map<string, MemEntry>();

let redis: Redis | null = null;
let redisHealthy = false;

try {
  redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    // ioredis defaults are fine; we just need fast-fail so we degrade cleanly
    // rather than block the event loop on a dead Redis box.
    connectTimeout: 1500,
  });
  redis.on('error', (err) => {
    if (redisHealthy) console.warn('[cache] redis error, degrading to memory:', err.message);
    redisHealthy = false;
  });
  redis.on('ready', () => {
    redisHealthy = true;
    console.log('[cache] redis connected at', REDIS_URL);
  });
  redis.connect().catch((err) => {
    console.warn('[cache] redis connect failed, using in-memory cache:', err.message);
    redisHealthy = false;
  });
} catch (err: any) {
  console.warn('[cache] redis init failed:', err.message);
  redis = null;
}

function memGet(k: string): string | null {
  const e = memFallback.get(k);
  if (!e) return null;
  if (e.expiresAt < Date.now()) { memFallback.delete(k); return null; }
  return e.value;
}
function memSet(k: string, v: string, ttlMs: number): void {
  memFallback.set(k, { value: v, expiresAt: Date.now() + ttlMs });
  // Bound the fallback map so it can't grow without limit during long Redis outages.
  if (memFallback.size > 5000) {
    const now = Date.now();
    for (const [key, ent] of memFallback) {
      if (ent.expiresAt < now) memFallback.delete(key);
      if (memFallback.size <= 4000) break;
    }
  }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const fullKey = KEY_PREFIX + key;
  try {
    if (redis && redisHealthy) {
      const v = await redis.get(fullKey);
      if (v != null) return JSON.parse(v) as T;
      return null;
    }
  } catch {
    redisHealthy = false;
  }
  const v = memGet(fullKey);
  return v ? (JSON.parse(v) as T) : null;
}

export async function cacheSet(key: string, value: unknown, ttlMs: number): Promise<void> {
  const fullKey = KEY_PREFIX + key;
  const payload = JSON.stringify(value);
  try {
    if (redis && redisHealthy) {
      await redis.set(fullKey, payload, 'PX', ttlMs);
      return;
    }
  } catch {
    redisHealthy = false;
  }
  memSet(fullKey, payload, ttlMs);
}

export async function cacheDel(key: string): Promise<void> {
  const fullKey = KEY_PREFIX + key;
  try {
    if (redis && redisHealthy) await redis.del(fullKey);
  } catch { /* ignore */ }
  memFallback.delete(fullKey);
}

/**
 * Deduplicate concurrent loads of the same key: if 30 clients ask for the
 * option chain at the same instant we want ONE upstream fetch, not 30.
 * In-process only — sufficient for a single-replica deployment.
 */
const inflight = new Map<string, Promise<any>>();

export async function cacheWrap<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  // Optional gate — only write to cache when the result is worth keeping.
  // Defaults to "anything non-null". Pass e.g. `v => v.candles.length > 0`
  // to AVOID memoising an empty-fetch result (rate-limit window etc.) —
  // otherwise the empty payload sticks for the full TTL and downstream
  // sees a blank chart while every retry serves the same empty cache hit.
  accept: (v: T) => boolean = (v) => v != null,
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit != null) return hit;
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    try {
      const val = await loader();
      if (val != null && accept(val)) {
        await cacheSet(key, val, ttlMs);
      } else {
        // Loader produced a result we don't want to memoise (e.g. empty
        // candles from a rate-limit miss). Actively evict any stale entry
        // so the next request retries upstream instead of serving the
        // remembered-empty payload.
        await cacheDel(key);
      }
      return val;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

export function cacheStatus(): { backend: 'redis' | 'memory'; healthy: boolean; size: number } {
  return {
    backend: redisHealthy ? 'redis' : 'memory',
    healthy: redisHealthy,
    size: memFallback.size,
  };
}
