/**
 * Angel One SmartWebSocketV2 — the single, process-wide live tick feed.
 *
 * Exactly ONE connection to Angel exists no matter how many frontend clients
 * connect or refresh: this is a singleton, and frontend clients only ever talk
 * to OUR ws server (see ws/wsServer.ts). Ticks land here and are pushed into
 * marketData's quote cache via injectLiveQuote(); the existing price loop reads
 * that cache, so the whole fan-out stays unchanged and REST polling becomes a
 * fallback instead of the primary source.
 *
 * Design notes
 *   • Subscriptions are driven by the desired symbol set (the union the price
 *     loop already computes). setDesired() diffs and sub/unsubscribes by token
 *     so there are never duplicate subscriptions or orphaned tokens.
 *   • Resilience: 30s heartbeat, exponential-backoff reconnect, full resubscribe
 *     on reconnect.
 *   • Safety: ticks are sanity-checked (price > 0, within a sane band of the
 *     last REST price) before they touch the cache, so a parsing glitch can
 *     never surface a wrong price — it just falls back to REST.
 *   • Testability: the WebSocket is created via an injectable factory and the
 *     binary parser + exchange map are pure exports, so the subscription /
 *     routing / reconnect logic is unit-testable with a mock socket (no live
 *     Angel connection required).
 */
import WebSocket from 'ws';
import { angel } from './angelOne';
import { injectLiveQuote, getLastKnownPrice } from './marketData';

const WS_URL = 'wss://smartapisocket.angelone.in/smart-stream';

// Angel exchangeType codes (SmartWebSocketV2). The scrip master's exchange
// strings map onto these.
const EXCHANGE_TYPE: Record<string, number> = {
  NSE: 1, // nse_cm (equity + index)
  BSE: 3, // bse_cm
  NFO: 2, // nse_fo
  BFO: 4, // bse_fo
  MCX: 5, // mcx_fo
  NCX: 7, // ncx_fo
  CDS: 13, // cde_fo
};

/** Map a scrip-master exchange string to an Angel exchangeType, or null. */
export function exchangeTypeFor(exchange: string): number | null {
  return EXCHANGE_TYPE[(exchange || '').toUpperCase()] ?? null;
}

// Subscription modes. Quote (2) gives LTP + close + volume in one packet, which
// is what we need for a correct day-change without a separate REST close.
const MODE_QUOTE = 2;
const QUOTE_PACKET_LEN = 123;
const LTP_PACKET_LEN = 51;

export interface ParsedTick {
  exchangeType: number;
  token: string;
  ltp: number; // rupees
  close: number; // rupees (0 if not present, e.g. LTP mode)
  volume: number;
}

/** Read a little-endian int64 at offset as a JS number (prices fit safely). */
function readI64(buf: Buffer, off: number): number {
  try {
    return Number(buf.readBigInt64LE(off));
  } catch {
    return 0;
  }
}

/** Extract the null-padded ASCII token from offset 2 (25 bytes). */
function readToken(buf: Buffer): string {
  let end = 2;
  while (end < 27 && buf[end] !== 0) end++;
  return buf.toString('ascii', 2, end);
}

/**
 * Parse one Angel binary frame, which may concatenate several packets. Handles
 * LTP (mode 1, 51 bytes) and Quote (mode 2, 123 bytes) packets; prices are sent
 * in paise → divided by 100.
 */
export function parseTickPackets(buf: Buffer): ParsedTick[] {
  const out: ParsedTick[] = [];
  let off = 0;
  while (off + LTP_PACKET_LEN <= buf.length) {
    const mode = buf[off];
    const len = mode === MODE_QUOTE ? QUOTE_PACKET_LEN : LTP_PACKET_LEN;
    if (off + len > buf.length) break;
    const pkt = buf.subarray(off, off + len);
    const exchangeType = pkt[1];
    const token = readToken(pkt);
    const ltp = readI64(pkt, 43) / 100;
    const close = len === QUOTE_PACKET_LEN ? readI64(pkt, 115) / 100 : 0;
    const volume = len === QUOTE_PACKET_LEN ? readI64(pkt, 67) : 0;
    if (token && Number.isFinite(ltp)) {
      out.push({ exchangeType, token, ltp, close, volume });
    }
    off += len;
  }
  return out;
}

interface TokenInfo {
  displaySymbol: string;
  exchange: string;
  exchangeType: number;
  token: string;
}

export type SocketLike = Pick<WebSocket, 'on' | 'send' | 'close' | 'readyState'> & {
  readyState: number;
};
export type SocketFactory = (
  url: string,
  headers: Record<string, string>,
) => SocketLike;

const defaultFactory: SocketFactory = (url, headers) =>
  new WebSocket(url, { headers }) as unknown as SocketLike;

export interface FeedCreds {
  jwtToken: string;
  feedToken: string;
  apiKey: string;
  clientCode: string;
}
export type CredsProvider = () => Promise<FeedCreds | null>;

export interface AngelFeedOpts {
  factory?: SocketFactory;
  getCreds?: CredsProvider;
}

export class AngelFeed {
  private socket: SocketLike | null = null;
  private connecting = false;
  private stopped = true;

  // Desired set (what callers want) and live set (what Angel currently has),
  // both keyed by `${exchangeType}:${token}`. Diffing the two yields the exact
  // sub/unsubscribe deltas — no duplicates, no orphans.
  private desired = new Map<string, TokenInfo>();
  private subscribed = new Set<string>();
  private byKey = new Map<string, TokenInfo>(); // key → info (for tick routing)

  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastTickAt = 0;
  private connectedSince = 0;

  private factory: SocketFactory;
  private getCreds: CredsProvider;
  constructor(opts: AngelFeedOpts = {}) {
    this.factory = opts.factory ?? defaultFactory;
    this.getCreds = opts.getCreds ?? (() => angel.getFeedCredentials());
  }

  private key(exchangeType: number, token: string): string {
    return `${exchangeType}:${token}`;
  }

  /** Connection / subscription health for monitoring + the /health probe. */
  status() {
    return {
      connected: !!this.socket && this.socket.readyState === 1,
      desired: this.desired.size,
      subscribed: this.subscribed.size,
      lastTickAt: this.lastTickAt,
      connectedSince: this.connectedSince,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  /**
   * Replace the desired subscription set with `infos`. Resolution of
   * display-symbol → {exchange, token} happens in the caller (it already has
   * Angel's resolver); we just diff and apply.
   */
  setDesired(infos: TokenInfo[]): void {
    const next = new Map<string, TokenInfo>();
    for (const i of infos) {
      const et = i.exchangeType ?? exchangeTypeFor(i.exchange);
      if (et == null || !i.token) continue;
      const k = this.key(et, i.token);
      next.set(k, { ...i, exchangeType: et });
      this.byKey.set(k, { ...i, exchangeType: et });
    }
    const adds: TokenInfo[] = [];
    const removes: TokenInfo[] = [];
    for (const [k, info] of next) if (!this.desired.has(k)) adds.push(info);
    for (const [k, info] of this.desired) if (!next.has(k)) removes.push(info);
    this.desired = next;

    if (!this.socket || this.socket.readyState !== 1) {
      // Not open yet — connect() will subscribe the whole desired set on open.
      this.ensureConnected();
      return;
    }
    if (adds.length) this.sendSub(adds, 1);
    if (removes.length) this.sendSub(removes, 0);
  }

  /** Begin/maintain the connection. Idempotent. */
  ensureConnected(): void {
    this.stopped = false;
    if (this.socket || this.connecting) return;
    void this.connect();
  }

  /** Tear down (used on shutdown / disable). */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    try { this.socket?.close(); } catch { /* ignore */ }
    this.socket = null;
    this.subscribed.clear();
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.stopped) return;
    this.connecting = true;
    try {
      const creds = await this.getCreds();
      if (!creds) {
        this.connecting = false;
        this.scheduleReconnect();
        return;
      }
      const headers = {
        Authorization: creds.jwtToken,
        'x-api-key': creds.apiKey,
        'x-client-code': creds.clientCode,
        'x-feed-token': creds.feedToken,
      };
      const sock = this.factory(WS_URL, headers);
      this.socket = sock;

      sock.on('open', () => {
        this.connecting = false;
        this.reconnectAttempts = 0;
        this.connectedSince = Date.now();
        this.subscribed.clear();
        // Full (re)subscribe of the desired set.
        const all = Array.from(this.desired.values());
        if (all.length) this.sendSub(all, 1);
        this.startHeartbeat();
        console.log('[angelFeed] connected; subscribing', all.length, 'tokens');
      });

      sock.on('message', (data: WebSocket.RawData, isBinary?: boolean) => {
        // Heartbeat replies arrive as text "pong".
        if (!isBinary) {
          const s = data.toString();
          if (s === 'pong' || s.includes('pong')) return;
          return;
        }
        this.onBinary(data as Buffer);
      });

      sock.on('error', (err: Error) => {
        console.warn('[angelFeed] socket error:', err?.message || err);
      });

      sock.on('close', () => {
        this.stopHeartbeat();
        this.socket = null;
        this.connecting = false;
        if (!this.stopped) {
          console.warn('[angelFeed] disconnected; will reconnect');
          this.scheduleReconnect();
        }
      });
    } catch (err: any) {
      this.connecting = false;
      console.warn('[angelFeed] connect failed:', err?.message || err);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // Angel expects a "ping" text frame periodically; it replies "pong".
    this.heartbeatTimer = setInterval(() => {
      const sock = this.socket;
      if (!sock || sock.readyState !== 1) return;
      try { sock.send('ping'); } catch { /* will surface via close */ }
      // Dead-feed detection: if we've been connected a while but no tick has
      // arrived in 60s during a presumably-active subscription, recycle.
      if (this.desired.size > 0 && this.lastTickAt && Date.now() - this.lastTickAt > 60_000) {
        console.warn('[angelFeed] no ticks in 60s — recycling connection');
        try { sock.close(); } catch { /* ignore */ }
      }
    }, 30_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private sendSub(infos: TokenInfo[], action: 0 | 1): void {
    const sock = this.socket;
    if (!sock || sock.readyState !== 1 || !infos.length) return;
    // Group tokens by exchangeType (Angel's tokenList shape).
    const byExch = new Map<number, string[]>();
    for (const i of infos) {
      const arr = byExch.get(i.exchangeType) || [];
      arr.push(i.token);
      byExch.set(i.exchangeType, arr);
      const k = this.key(i.exchangeType, i.token);
      if (action === 1) this.subscribed.add(k);
      else this.subscribed.delete(k);
    }
    const msg = {
      correlationID: `feed-${Date.now()}`,
      action,
      params: {
        mode: MODE_QUOTE,
        tokenList: Array.from(byExch.entries()).map(([exchangeType, tokens]) => ({
          exchangeType,
          tokens,
        })),
      },
    };
    try { sock.send(JSON.stringify(msg)); } catch (err: any) {
      console.warn('[angelFeed] sub send failed:', err?.message || err);
    }
  }

  private onBinary(buf: Buffer): void {
    const ticks = parseTickPackets(buf);
    if (!ticks.length) return;
    this.lastTickAt = Date.now();
    for (const t of ticks) {
      const info = this.byKey.get(this.key(t.exchangeType, t.token));
      if (!info) continue; // unknown token (race after unsubscribe) — ignore
      if (!this.sane(info.displaySymbol, t.ltp)) continue;
      injectLiveQuote(info.displaySymbol, t.ltp, {
        close: t.close > 0 ? t.close : undefined,
        volume: t.volume,
        exchange: info.exchange,
      });
    }
  }

  /**
   * Reject obviously-bad ticks (≤0, or wildly off the last REST price) so a
   * mis-parsed byte can never surface a wrong price. A tick within ±25% of the
   * last-known price is accepted; with no reference yet, any positive price is.
   */
  private sane(displaySymbol: string, ltp: number): boolean {
    if (!(ltp > 0)) return false;
    const ref = getLastKnownPrice(displaySymbol)?.price;
    if (!ref || ref <= 0) return true;
    const ratio = ltp / ref;
    return ratio > 0.75 && ratio < 1.25;
  }
}

export const angelFeed = new AngelFeed();
