/**
 * Angel One SmartAPI client.
 *
 * Handles:
 *  - TOTP-based login + automatic re-auth on session expiry
 *  - On-demand symbol → token resolution via `searchScrip` (cached in memory).
 *    Replaces the older "download 30 MB scrip-master file" approach, which
 *    Angel One has taken offline.
 *  - Batched LTP/OHLC quote fetch (`market/v1/quote`)
 *  - Historical candle fetch (`historical/v1/getCandleData`) for charts
 *
 * The module exposes a single `angel` singleton; consumers call
 *   `angel.getQuotes(['NIFTY','RELIANCE'])` or `angel.getHistory(sym,'1D')`.
 */
import axios, { AxiosInstance } from 'axios';
// speakeasy has no bundled types
// eslint-disable-next-line @typescript-eslint/no-var-requires
const speakeasy: any = require('speakeasy');
import fs from 'fs';
import path from 'path';
import { env, angelEnabled } from '../config/env';
import { scripMaster } from './scripMaster';

// Persistent cache of resolved tokens so we don't repeatedly hit searchScrip.
const TOKEN_CACHE_FILE = path.resolve(process.cwd(), '.cache', 'angel-tokens.json');
const TOKEN_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Return the start of the relevant trading session for a given exchange.
 *
 * NSE / BSE / NFO / BFO / CDS  — 09:15 IST → 15:30 IST (Mon–Fri).
 * MCX / NCDEX / NCO            — 09:00 IST → 23:30 IST (Mon–Fri).
 *
 * Returns either today's open (if we're still in/just after that session)
 * or the previous trading day's open (after close or on weekends). This
 * matches how TradingView / Groww render their "1D" intraday chart.
 */
function sessionAnchor(exchange: string, now: Date): Date {
  const isMcx = /MCX|NCDEX|NCO/.test(exchange);
  const openH = isMcx ? 9 : 9;
  const openM = isMcx ? 0 : 15;
  const closeH = isMcx ? 23 : 15;
  const closeM = isMcx ? 30 : 30;

  // IST offset
  const utcMs = now.getTime();
  const istMs = utcMs + (5.5 * 60 * 60 * 1000);
  const ist = new Date(istMs);

  let y = ist.getUTCFullYear();
  let m = ist.getUTCMonth();
  let d = ist.getUTCDate();
  const dow = ist.getUTCDay(); // 0 = Sunday, 6 = Saturday

  const minOfDay = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const openMin = openH * 60 + openM;
  const closeMin = closeH * 60 + closeM;
  const afterToday = minOfDay > closeMin;
  const beforeToday = minOfDay < openMin;

  // Step back day by day until we land on a weekday session we can use
  const stepBack = beforeToday || afterToday || dow === 0 || dow === 6;
  if (stepBack) {
    // Walk back to the most recent trading-day's open
    let cursor = new Date(Date.UTC(y, m, d, openH, openM));
    if (beforeToday && dow !== 0 && dow !== 6) {
      // Before today's open → use yesterday's session (or further back if weekend)
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    cursor.setUTCHours(openH, openM, 0, 0);
    // Convert back to UTC clock by subtracting IST offset
    return new Date(cursor.getTime() - 5.5 * 60 * 60 * 1000);
  }

  // We're inside today's session
  const todayOpenIst = new Date(Date.UTC(y, m, d, openH, openM));
  return new Date(todayOpenIst.getTime() - 5.5 * 60 * 60 * 1000);
}

export interface AngelQuote {
  symbol: string;
  yahooSymbol: string;
  exchange: string;
  token: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  changePercent: number;
  timestamp: number;
}

export interface AngelCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ResolvedSymbol {
  exchange: string;
  token: string;
  tradingSymbol: string;
}

const BASE_URL = 'https://apiconnect.angelone.in';

// Hardcoded tokens for instruments. Avoids hitting Angel's searchScrip
// rate limit for the most common symbols (indices + top NSE stocks).
const PRESEED_TOKENS: Record<string, ResolvedSymbol> = {
  // ---- Indices ----
  NIFTY:        { exchange: 'NSE', token: '99926000', tradingSymbol: 'Nifty 50' },
  'NIFTY 50':   { exchange: 'NSE', token: '99926000', tradingSymbol: 'Nifty 50' },
  BANKNIFTY:    { exchange: 'NSE', token: '99926009', tradingSymbol: 'Nifty Bank' },
  'NIFTY BANK': { exchange: 'NSE', token: '99926009', tradingSymbol: 'Nifty Bank' },
  FINNIFTY:     { exchange: 'NSE', token: '99926037', tradingSymbol: 'Nifty Fin Service' },
  SENSEX:       { exchange: 'BSE', token: '99919000', tradingSymbol: 'SENSEX' },
  'BSE SENSEX': { exchange: 'BSE', token: '99919000', tradingSymbol: 'SENSEX' },
  'GIFT NIFTY': { exchange: 'NSE', token: '99926000', tradingSymbol: 'Nifty 50' },
  // ---- Top NSE equities (stable tokens) ----
  RELIANCE:   { exchange: 'NSE', token: '2885',  tradingSymbol: 'RELIANCE-EQ' },
  TCS:        { exchange: 'NSE', token: '11536', tradingSymbol: 'TCS-EQ' },
  INFY:       { exchange: 'NSE', token: '1594',  tradingSymbol: 'INFY-EQ' },
  HDFCBANK:   { exchange: 'NSE', token: '1333',  tradingSymbol: 'HDFCBANK-EQ' },
  ICICIBANK:  { exchange: 'NSE', token: '4963',  tradingSymbol: 'ICICIBANK-EQ' },
  SBIN:       { exchange: 'NSE', token: '3045',  tradingSymbol: 'SBIN-EQ' },
  WIPRO:      { exchange: 'NSE', token: '3787',  tradingSymbol: 'WIPRO-EQ' },
  HCLTECH:    { exchange: 'NSE', token: '7229',  tradingSymbol: 'HCLTECH-EQ' },
  AXISBANK:   { exchange: 'NSE', token: '5900',  tradingSymbol: 'AXISBANK-EQ' },
  KOTAKBANK:  { exchange: 'NSE', token: '1922',  tradingSymbol: 'KOTAKBANK-EQ' },
  ITC:        { exchange: 'NSE', token: '1660',  tradingSymbol: 'ITC-EQ' },
  HINDUNILVR: { exchange: 'NSE', token: '1394',  tradingSymbol: 'HINDUNILVR-EQ' },
  LT:         { exchange: 'NSE', token: '11483', tradingSymbol: 'LT-EQ' },
  BHARTIARTL: { exchange: 'NSE', token: '10604', tradingSymbol: 'BHARTIARTL-EQ' },
  BAJFINANCE: { exchange: 'NSE', token: '317',   tradingSymbol: 'BAJFINANCE-EQ' },
  ASIANPAINT: { exchange: 'NSE', token: '236',   tradingSymbol: 'ASIANPAINT-EQ' },
  MARUTI:     { exchange: 'NSE', token: '10999', tradingSymbol: 'MARUTI-EQ' },
  TITAN:      { exchange: 'NSE', token: '3506',  tradingSymbol: 'TITAN-EQ' },
  ADANIENT:   { exchange: 'NSE', token: '25',    tradingSymbol: 'ADANIENT-EQ' },
  TATAMOTORS: { exchange: 'NSE', token: '3456',  tradingSymbol: 'TATAMOTORS-EQ' },
};

// Friendly commodity names → MCX search prefix (we'll pick the nearest-expiry future).
const COMMODITY_FRIENDLY = new Set(['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER']);

// Parse "GOLD05DEC25FUT" → Date(2025-12-05). Returns null if it can't parse.
function parseExpiry(tradingSymbol: string): Date | null {
  const m = tradingSymbol.match(/(\d{1,2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const month = months[m[2].toUpperCase()];
  const yr = 2000 + parseInt(m[3], 10);
  return new Date(yr, month, day);
}

class AngelOneClient {
  private http: AxiosInstance;
  private jwtToken: string | null = null;
  private refreshToken: string | null = null;
  private feedToken: string | null = null;
  private loginPromise: Promise<void> | null = null;
  private loginedAt = 0;

  /** Cache: uppercase user input ("RELIANCE") → resolved token. Persists for process lifetime. */
  private resolveCache = new Map<string, ResolvedSymbol>();
  /** Pending lookups so concurrent quote calls for the same symbol don't duplicate work. */
  private resolvePromises = new Map<string, Promise<ResolvedSymbol | null>>();

  public enabled = angelEnabled;

  /** Last time we hit searchScrip — used to space out calls so we don't trip Angel's rate limit. */
  private lastSearchAt = 0;
  /** Queue tail: each searchScrip awaits the previous one + a small spacing delay. */
  private searchQueue: Promise<any> = Promise.resolve();

  /**
   * Global min-spaced queue for ALL quote-style HTTP calls (LTP/OHLC/FULL
   * + historical candles). Angel rate-limits the user-level quote endpoint
   * tightly; when the price loop, option chain, snapshot, and candles
   * endpoints all fire in the same 100 ms window they collectively trip
   * the limit and open the 5s breaker. Serialising through one queue
   * spaced by `QUOTE_MIN_SPACING_MS` smooths the burst without slowing
   * the steady-state — a 500 ms tick has plenty of headroom for 4
   * sequential calls.
   */
  private quoteQueue: Promise<any> = Promise.resolve();
  private lastQuoteAt = 0;
  // 250 ms ≈ 4 calls/sec sustained. Angel's per-user quote budget is tighter
  // than the documented per-app limit, and we've observed the breaker open
  // at burst rates above ~5/sec. 250 ms gives the price loop, option chain
  // poll, and order placement room to coexist without tripping it.
  private static readonly QUOTE_MIN_SPACING_MS = 250;
  // Rate-limit-log de-noise. Without this we print "rate limit hit" 20+ times
  // per breaker window — useless noise. Print once per breaker open instead.
  private lastRateLogAt = 0;

  private spaceQuote<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = Math.max(0, AngelOneClient.QUOTE_MIN_SPACING_MS - (Date.now() - this.lastQuoteAt));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastQuoteAt = Date.now();
      return fn();
    };
    // Chain even on failures so one rejection doesn't break the queue.
    const next = this.quoteQueue.then(run, run);
    this.quoteQueue = next.catch(() => {});
    return next as Promise<T>;
  }

  constructor() {
    this.http = axios.create({
      baseURL: BASE_URL,
      // 12s (was 20s): a quote that hasn't answered in 12s is effectively down;
      // failing faster lets the option-chain fall back to its last-good cache
      // instead of leaving the user staring at a blank chain for 20s.
      timeout: 12_000,
      headers: this.staticHeaders(),
    });
    // Seed cache with hardcoded indices + top stocks
    for (const [k, v] of Object.entries(PRESEED_TOKENS)) this.resolveCache.set(k, v);
    // Hydrate from disk if available
    this.loadTokenCacheFromDisk();
  }

  private loadTokenCacheFromDisk(): void {
    try {
      if (!fs.existsSync(TOKEN_CACHE_FILE)) return;
      if (Date.now() - fs.statSync(TOKEN_CACHE_FILE).mtimeMs > TOKEN_CACHE_TTL) return;
      const raw = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw)) {
        if (!this.resolveCache.has(k)) this.resolveCache.set(k, v as ResolvedSymbol);
      }
      console.log(`[angelOne] hydrated ${Object.keys(raw).length} cached tokens from disk`);
    } catch (err: any) {
      console.warn('[angelOne] could not load token cache:', err.message);
    }
  }

  private saveTokenCacheToDisk(): void {
    try {
      fs.mkdirSync(path.dirname(TOKEN_CACHE_FILE), { recursive: true });
      const obj = Object.fromEntries(this.resolveCache.entries());
      fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(obj, null, 2));
    } catch {
      /* non-fatal */
    }
  }

  private staticHeaders() {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '192.168.1.1',
      'X-ClientPublicIP': '106.193.147.98',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': env.ANGEL_KEY,
    };
  }

  private authHeaders() {
    return {
      ...this.staticHeaders(),
      Authorization: `Bearer ${this.jwtToken}`,
    };
  }

  async login(force = false): Promise<void> {
    if (!this.enabled) throw new Error('Angel One credentials missing');
    // Sessions are good for ~24h; refresh proactively after 6h
    if (!force && this.jwtToken && Date.now() - this.loginedAt < 6 * 60 * 60 * 1000) return;
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = (async () => {
      try {
        const totp = speakeasy.totp({
          secret: env.ANGEL_TOTP.replace(/\s/g, '').toUpperCase(),
          encoding: 'base32',
        });
        const res = await this.http.post(
          '/rest/auth/angelbroking/user/v1/loginByPassword',
          {
            clientcode: env.ANGEL_CLIENT_CODE,
            password: env.ANGEL_PASSWORD,
            totp,
          },
          { headers: this.staticHeaders() }
        );
        if (!res.data?.status) {
          throw new Error(`Angel login failed: ${res.data?.message || JSON.stringify(res.data)}`);
        }
        this.jwtToken = res.data.data.jwtToken;
        this.refreshToken = res.data.data.refreshToken;
        this.feedToken = res.data.data.feedToken;
        this.loginedAt = Date.now();
        console.log('[angelOne] login OK as', env.ANGEL_CLIENT_CODE);
      } finally {
        this.loginPromise = null;
      }
    })();

    return this.loginPromise;
  }

  /**
   * Look up a symbol via Angel One's searchScrip endpoint. Calls are serialized
   * with at least 350 ms spacing so we don't trip Angel's rate limit
   * ("Access denied because of exceeding access rate"). Backs off + retries on 403.
   */
  private async searchScrip(exchange: string, query: string): Promise<any[]> {
    await this.login();

    // Chain onto the existing queue tail so calls are strictly sequential.
    const work = this.searchQueue.then(async () => {
      const since = Date.now() - this.lastSearchAt;
      const spacing = 350;
      if (since < spacing) await sleep(spacing - since);

      const doCall = async () => {
        const res = await this.http.post(
          '/rest/secure/angelbroking/order/v1/searchScrip',
          { exchange, searchscrip: query },
          { headers: this.authHeaders() }
        );
        return res.data?.data || [];
      };

      try {
        const out = await doCall();
        this.lastSearchAt = Date.now();
        return out;
      } catch (err: any) {
        const status = err?.response?.status;
        const message = err?.response?.data?.message || err?.response?.data?.errorcode || '';
        if (status === 401) {
          await this.login(true);
          this.lastSearchAt = Date.now();
          return doCall();
        }
        if (status === 403 || /rate/i.test(String(message))) {
          // Back off and retry once
          await sleep(1500);
          try {
            const out = await doCall();
            this.lastSearchAt = Date.now();
            return out;
          } catch (e2: any) {
            console.warn(`[angelOne] searchScrip(${exchange}, ${query}) still rate-limited`);
            this.lastSearchAt = Date.now();
            return [];
          }
        }
        console.error(`[angelOne] searchScrip(${exchange}, ${query}) error:`, err.message || err);
        this.lastSearchAt = Date.now();
        return [];
      }
    });

    // Update queue tail (swallow errors so they don't poison the chain)
    this.searchQueue = work.catch(() => {});
    return work;
  }

  /**
   * Resolve a free-form user symbol ("RELIANCE", "NIFTY", "GOLD", "TCS-EQ",
   * "NSE:HDFCBANK") to an Angel exchange + token. Cached.
   *
   * Commodity friendlies (GOLD/SILVER/CRUDEOIL/…) re-validate the cached
   * contract's expiry — if the cached future has expired we drop it and
   * fall through to searchScrip again. Otherwise we'd silently route quotes
   * and chart history to a delisted token.
   */
  async resolve(input: string): Promise<ResolvedSymbol | null> {
    const raw = input.trim().toUpperCase();
    if (!raw) return null;

    const cached = this.resolveCache.get(raw);
    if (cached) {
      if (COMMODITY_FRIENDLY.has(raw)) {
        const expiry = parseExpiry(cached.tradingSymbol || '');
        if (expiry && expiry.getTime() <= Date.now()) {
          // Stale — evict and fall through to fresh search
          this.resolveCache.delete(raw);
          this.saveTokenCacheToDisk();
        } else {
          return cached;
        }
      } else {
        return cached;
      }
    }

    const pending = this.resolvePromises.get(raw);
    if (pending) return pending;

    const promise = (async (): Promise<ResolvedSymbol | null> => {
      // Explicit "EXCHANGE:SYMBOL" prefix
      let exchange = 'NSE';
      let query = raw;
      if (raw.includes(':')) {
        const [ex, sym] = raw.split(':');
        exchange = ex;
        query = sym;
      }

      // Option contract fast-path (e.g. NIFTY26MAY2624000PE, RELIANCE26MAY261300CE).
      // Angel's searchScrip endpoint doesn't index individual option legs, so
      // hitting it for an option just burns a rate-limit slot and returns
      // nothing. The scrip master we hydrate at boot has every option leg
      // with its exchange + token already, so resolve through that and skip
      // the network hop entirely.
      if (/\d(?:CE|PE)$/.test(query)) {
        const inst = scripMaster.findOptionByTradingSymbol?.(query);
        if (inst) {
          const r: ResolvedSymbol = {
            exchange: inst.exch_seg,
            token: String(inst.token),
            tradingSymbol: inst.symbol,
          };
          this.resolveCache.set(raw, r);
          this.saveTokenCacheToDisk();
          return r;
        }
        return null;
      }
      // Futures fast-path — same reasoning (NIFTY26MAYFUT, GOLD26MAYFUT, …).
      if (/\d[A-Z]{3}\d{0,2}FUT$/.test(query)) {
        const inst = scripMaster.findOptionByTradingSymbol?.(query);
        if (inst) {
          const r: ResolvedSymbol = {
            exchange: inst.exch_seg,
            token: String(inst.token),
            tradingSymbol: inst.symbol,
          };
          this.resolveCache.set(raw, r);
          this.saveTokenCacheToDisk();
          return r;
        }
      }

      // Commodities → search MCX, pick the nearest UNEXPIRED future
      if (COMMODITY_FRIENDLY.has(raw)) {
        const results = await this.searchScrip('MCX', raw);
        const now = Date.now();
        const candidates = results
          .filter((r: any) => {
            const t = String(r.tradingsymbol || '');
            if (!/FUT$/i.test(t)) return false;            // futures only
            // Skip mini/micro contracts unless explicitly requested.
            // E.g. for "GOLD" we want "GOLD…FUT", not "GOLDM…FUT" or "GOLDPETAL".
            const base = t.replace(/\d.*$/, '').toUpperCase();
            return base === raw;
          })
          .map((r: any) => ({ ...r, _expiry: parseExpiry(r.tradingsymbol) }))
          .filter((r: any) => r._expiry && r._expiry.getTime() > now)
          .sort((a: any, b: any) => a._expiry.getTime() - b._expiry.getTime());

        const pick = candidates[0] || results[0];
        if (pick) {
          const r: ResolvedSymbol = {
            exchange: 'MCX',
            token: String(pick.symboltoken),
            tradingSymbol: pick.tradingsymbol,
          };
          this.resolveCache.set(raw, r);
          this.saveTokenCacheToDisk();
          return r;
        }
        return null;
      }

      const results = await this.searchScrip(exchange, query);
      if (!results.length && exchange === 'NSE') {
        // Fallback to BSE
        const bse = await this.searchScrip('BSE', query);
        if (bse.length) {
          const pick: any = bse[0];
          const r: ResolvedSymbol = {
            exchange: 'BSE',
            token: String(pick.symboltoken),
            tradingSymbol: pick.tradingsymbol,
          };
          this.resolveCache.set(raw, r);
          this.saveTokenCacheToDisk();
          return r;
        }
        return null;
      }

      // Prefer "-EQ" for equities
      const eq = results.find((r: any) => /-EQ$/.test(r.tradingsymbol));
      const pick: any = eq || results[0];
      if (!pick) return null;
      const r: ResolvedSymbol = {
        exchange,
        token: String(pick.symboltoken),
        tradingSymbol: pick.tradingsymbol,
      };
      this.resolveCache.set(raw, r);
      this.saveTokenCacheToDisk();
      return r;
    })();

    this.resolvePromises.set(raw, promise);
    try {
      return await promise;
    } finally {
      this.resolvePromises.delete(raw);
    }
  }

  /** Backwards-compat alias for the rest of the codebase. */
  async ensureInstruments(): Promise<void> {
    // No-op in the searchScrip approach. Just ensure we're logged in.
    await this.login();
  }

  /** Build a "yahoo-style" key so quote-cache stays consistent across providers. */
  yahooStyleKey(displaySymbol: string, exchange: string): string {
    const upper = displaySymbol.toUpperCase();
    if (PRESEED_TOKENS[upper]) return upper;
    if (COMMODITY_FRIENDLY.has(upper)) return upper;
    if (exchange === 'BSE') return `${displaySymbol}.BO`;
    if (exchange === 'NSE') return `${displaySymbol}.NS`;
    return displaySymbol;
  }

  async getQuotes(displaySymbols: string[]): Promise<AngelQuote[]> {
    if (displaySymbols.length === 0) return [];
    await this.login();

    // Resolve all symbols in parallel (cached after first call)
    const resolutions = await Promise.all(
      displaySymbols.map(async (s) => ({ input: s, r: await this.resolve(s) }))
    );

    // Multiple display names can resolve to the SAME Angel token (e.g.
    // "NIFTY" and "GIFT NIFTY" both → 99926000). We need every input name
    // to receive the quote — not just the last one — so we keep a list
    // per (exchange, token).
    const grouped: Record<string, Set<string>> = {};
    const meta = new Map<string, string[]>(); // "EXCH:TOKEN" → [input names…]
    for (const { input, r } of resolutions) {
      if (!r) continue;
      (grouped[r.exchange] ||= new Set()).add(r.token);
      const key = `${r.exchange}:${r.token}`;
      const list = meta.get(key) || [];
      list.push(input.toUpperCase());
      meta.set(key, list);
    }
    if (Object.keys(grouped).length === 0) return [];

    // OHLC mode is available to all accounts; FULL mode adds depth / 52w stats
    // but is sometimes throttled, so prefer OHLC for the high-frequency tick loop.
    const body = {
      mode: 'OHLC',
      exchangeTokens: Object.fromEntries(
        Object.entries(grouped).map(([k, v]) => [k, Array.from(v)])
      ),
    };
    return this.runQuote(body, meta);
  }

  /** Like getQuotes but requests FULL mode (52w hi/lo, OI, market depth). */
  async getQuotesFull(displaySymbols: string[]): Promise<any[]> {
    if (displaySymbols.length === 0) return [];
    await this.login();
    const resolutions = await Promise.all(
      displaySymbols.map(async (s) => ({ input: s, r: await this.resolve(s) }))
    );
    const grouped: Record<string, string[]> = {};
    const meta = new Map<string, string>();
    for (const { input, r } of resolutions) {
      if (!r) continue;
      (grouped[r.exchange] ||= []).push(r.token);
      meta.set(`${r.exchange}:${r.token}`, input.toUpperCase());
    }
    if (Object.keys(grouped).length === 0) return [];
    const body = { mode: 'FULL', exchangeTokens: grouped };
    const raw = await this.runQuoteRaw(body);
    return raw.map((q: any) => ({
      ...q,
      input: meta.get(`${q.exchange}:${q.symbolToken}`),
    }));
  }

  private async runQuote(body: any, meta: Map<string, string[]>): Promise<AngelQuote[]> {
    // Hot-fail when the rate-limit breaker is open — saves a roundtrip AND
    // keeps us from extending the throttle window further.
    if (Date.now() < (this as any).__rlOpenUntil) return [];

    let res;
    try {
      res = await this.spaceQuote(() =>
        this.http.post('/rest/secure/angelbroking/market/v1/quote/', body, {
          headers: this.authHeaders(),
        })
      );
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      const bodyStr = typeof data === 'string' ? data : JSON.stringify(data ?? {});
      const isRateLimited = status === 403 && /access denied.*exceed.*rate|exceed.*access rate/i.test(bodyStr);

      if (isRateLimited) {
        // DO NOT re-login on a rate-limit 403 — login itself counts toward
        // the limit and would deepen the throttle. Open a 5 s breaker.
        (this as any).__rlOpenUntil = Date.now() + 5000;
        // Dedupe the warning: only log if it's been > 5 s since the last one.
        if (Date.now() - this.lastRateLogAt > 5000) {
          console.warn('[angelOne] rate limit hit, breaker open 5s');
          this.lastRateLogAt = Date.now();
        }
        return [];
      }
      console.error(
        `[angelOne] quote HTTP ${status} body:`,
        bodyStr.slice(0, 300),
        'request body:',
        JSON.stringify(body)
      );
      if (status === 401) {
        console.warn('[angelOne] auth expired, re-logging in');
        await this.login(true);
        res = await this.http.post('/rest/secure/angelbroking/market/v1/quote/', body, {
          headers: this.authHeaders(),
        });
      } else {
        throw err;
      }
    }

    // Angel returns 200 OK with `status: false` for expired sessions
    // ("Invalid Token", "Session Expired"). Re-login transparently and
    // retry ONCE so a soft session timeout doesn't surface to callers.
    if (!res.data?.status) {
      const msg = String(res.data?.message || '').toLowerCase();
      const isExpired = /invalid token|session expired|jwt expired|unauthorised|unauthorized/.test(msg);
      if (isExpired) {
        console.warn('[angelOne] session expired (body status=false), re-logging in');
        await this.login(true);
        res = await this.http.post('/rest/secure/angelbroking/market/v1/quote/', body, {
          headers: this.authHeaders(),
        });
      }
      if (!res.data?.status) {
        throw new Error(`Angel quote failed: ${res.data?.message || JSON.stringify(res.data)}`);
      }
    }

    const fetched: any[] = res.data?.data?.fetched || [];
    const now = Date.now();
    const out: AngelQuote[] = [];
    for (const q of fetched) {
      if (q?.ltp == null) continue;
      const displays = meta.get(`${q.exchange}:${q.symbolToken}`) || [q.tradingSymbol];
      const ltp = Number(q.ltp);
      const close = Number(q.close ?? ltp);
      const change = ltp - close;
      // Emit one AngelQuote per display name that resolved to this token
      // so every subscribed alias (e.g. "GIFT NIFTY" + "NIFTY") gets the update.
      for (const display of displays) {
        out.push({
          symbol: display,
          yahooSymbol: this.yahooStyleKey(display, q.exchange),
          exchange: q.exchange,
          token: String(q.symbolToken),
          ltp,
          open: Number(q.open ?? ltp),
          high: Number(q.high ?? ltp),
          low: Number(q.low ?? ltp),
          close,
          change,
          changePercent: close ? (change / close) * 100 : 0,
          timestamp: now,
        });
      }
    }
    return out;
  }

  /** Raw quote rows (used by FULL mode / option-chain). Falls back to OHLC on 403. */
  private async runQuoteRaw(body: any): Promise<any[]> {
    if (Date.now() < (this as any).__rlOpenUntil) return [];
    try {
      let res = await this.spaceQuote(() =>
        this.http.post(
          '/rest/secure/angelbroking/market/v1/quote/',
          body,
          { headers: this.authHeaders() }
        )
      );
      // Soft session expiry: 200 OK + status:false + "Invalid Token" → relogin
      if (!res.data?.status) {
        const msg = String(res.data?.message || '').toLowerCase();
        if (/invalid token|session expired|jwt expired|unauthori[sz]ed/.test(msg)) {
          console.warn('[angelOne] raw quote — session expired, re-logging in');
          await this.login(true);
          res = await this.http.post(
            '/rest/secure/angelbroking/market/v1/quote/',
            body,
            { headers: this.authHeaders() }
          );
        }
      }
      if (!res.data?.status) return [];
      return res.data?.data?.fetched || [];
    } catch (err: any) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      const bodyStr = typeof data === 'string' ? data : JSON.stringify(data ?? {});
      const isRateLimited = status === 403 && /access denied.*exceed.*rate|exceed.*access rate/i.test(bodyStr);
      if (isRateLimited) {
        (this as any).__rlOpenUntil = Date.now() + 5000;
        if (Date.now() - this.lastRateLogAt > 5000) {
          console.warn('[angelOne] rate limit hit (raw), breaker open 5s');
          this.lastRateLogAt = Date.now();
        }
        return [];
      }
      if (status === 401) {
        await this.login(true);
        const res = await this.http.post(
          '/rest/secure/angelbroking/market/v1/quote/',
          body,
          { headers: this.authHeaders() }
        );
        return res.data?.data?.fetched || [];
      }
      if (status === 403 && body.mode === 'FULL') {
        // Account doesn't have depth subscription — fall back to OHLC.
        // (This is a different 403: "Account not authorized for FULL".)
        console.warn('[angelOne] FULL mode not allowed, falling back to OHLC');
        const res2 = await this.http.post(
          '/rest/secure/angelbroking/market/v1/quote/',
          { ...body, mode: 'OHLC' },
          { headers: this.authHeaders() }
        );
        return res2.data?.data?.fetched || [];
      }
      console.error('[angelOne] runQuoteRaw error', status, err.message);
      return [];
    }
  }

  /** Batch-quote a list of {exchange, token} pairs directly (no symbol resolution). */
  async getQuotesByTokens(
    pairs: { exchange: string; token: string }[],
    mode: 'LTP' | 'OHLC' | 'FULL' = 'OHLC'
  ): Promise<any[]> {
    if (!pairs.length) return [];
    await this.login();
    const grouped: Record<string, string[]> = {};
    for (const p of pairs) (grouped[p.exchange] ||= []).push(String(p.token));
    return this.runQuoteRaw({ mode, exchangeTokens: grouped });
  }

  async getHistory(
    displaySymbol: string,
    period: '1D' | '1W' | '1M' | '3M' | '6M' | '1Y' | '3Y' | '5Y' | 'ALL'
  ): Promise<AngelCandle[]> {
    await this.login();
    const r = await this.resolve(displaySymbol);
    if (!r) return [];

    const now = new Date();
    let from = new Date();
    let interval = 'FIVE_MINUTE';

    if (period === '1D') {
      // Anchor to the START of the current (or last) trading session in IST.
      // ONE_MINUTE candles give the dense "every tick" look on the 1D chart
      // (~375 bars per NSE session vs ~75 at 5-min). Angel allows up to 30
      // days of 1-minute candles per request, well above what we ask for.
      from = sessionAnchor(r.exchange, now);
      interval = 'ONE_MINUTE';
    } else {
      // Finer-grained intervals at each zoom level so the chart never
      // looks "polygonal". All within Angel's per-interval lookback limits:
      //   THREE_MINUTE   ≤ 60 days   · FIVE_MINUTE   ≤ 100 days
      //   FIFTEEN_MINUTE ≤ 200 days  · ONE_HOUR      ≤ 400 days
      //   ONE_DAY        ≤ 2000 days
      switch (period) {
        case '1W':  from.setDate(now.getDate() - 7);          interval = 'FIVE_MINUTE';    break;
        case '1M':  from.setMonth(now.getMonth() - 1);        interval = 'FIFTEEN_MINUTE'; break;
        case '3M':  from.setMonth(now.getMonth() - 3);        interval = 'ONE_HOUR';       break;
        case '6M':  from.setMonth(now.getMonth() - 6);        interval = 'ONE_DAY';        break;
        case '1Y':  from.setFullYear(now.getFullYear() - 1);  interval = 'ONE_DAY';        break;
        case '3Y':  from.setFullYear(now.getFullYear() - 3);  interval = 'ONE_DAY';        break;
        case '5Y':  from.setFullYear(now.getFullYear() - 5);  interval = 'ONE_DAY';        break;
        case 'ALL': from.setFullYear(now.getFullYear() - 10); interval = 'ONE_DAY';        break;
      }
    }

    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    const body = {
      exchange: r.exchange,
      symboltoken: r.token,
      interval,
      fromdate: fmt(from),
      todate: fmt(now),
    };

    let res;
    try {
      res = await this.spaceQuote(() =>
        this.http.post('/rest/secure/angelbroking/historical/v1/getCandleData', body, {
          headers: this.authHeaders(),
        })
      );
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        await this.login(true);
        res = await this.http.post('/rest/secure/angelbroking/historical/v1/getCandleData', body, {
          headers: this.authHeaders(),
        });
      } else {
        console.error('[angelOne] history HTTP error:', err.message || err);
        return [];
      }
    }

    if (!res.data?.status) {
      console.error('[angelOne] history error:', res.data?.message);
      return [];
    }
    const rows: any[] = res.data?.data || [];
    return rows.map((row) => ({
      time: Math.floor(new Date(row[0]).getTime() / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5] || 0),
    }));
  }

  /**
   * Fetch raw candles for a specific Angel-native interval over a custom
   * lookback window. Used by the terminal's timeframe selector — gives full
   * control over (interval, lookbackDays) instead of the coarse period-based
   * mapping `getHistory()` uses.
   */
  async getCandles(
    displaySymbol: string,
    angelInterval: 'ONE_MINUTE' | 'THREE_MINUTE' | 'FIVE_MINUTE' | 'TEN_MINUTE'
                 | 'FIFTEEN_MINUTE' | 'THIRTY_MINUTE' | 'ONE_HOUR' | 'ONE_DAY',
    lookbackDays: number,
  ): Promise<AngelCandle[]> {
    await this.login();
    const r = await this.resolve(displaySymbol);
    if (!r) return [];

    const now = new Date();
    const from = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

    const body = {
      exchange: r.exchange,
      symboltoken: r.token,
      interval: angelInterval,
      fromdate: fmt(from),
      todate: fmt(now),
    };

    let res;
    try {
      res = await this.spaceQuote(() =>
        this.http.post('/rest/secure/angelbroking/historical/v1/getCandleData', body, {
          headers: this.authHeaders(),
        })
      );
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        await this.login(true);
        res = await this.http.post('/rest/secure/angelbroking/historical/v1/getCandleData', body, {
          headers: this.authHeaders(),
        });
      } else {
        console.error('[angelOne] getCandles HTTP error:', err.message || err);
        return [];
      }
    }

    if (!res.data?.status) {
      console.error('[angelOne] getCandles error:', res.data?.message);
      return [];
    }
    const rows: any[] = res.data?.data || [];
    return rows.map((row) => ({
      time: Math.floor(new Date(row[0]).getTime() / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5] || 0),
    }));
  }

  /** Convenience search for the symbol picker UI. */
  async searchInstruments(
    q: string,
    limit = 10
  ): Promise<{ symbol: string; name: string; exchange: string }[]> {
    if (!q.trim()) return [];
    await this.login();
    const [nse, bse] = await Promise.all([
      this.searchScrip('NSE', q.trim()),
      this.searchScrip('BSE', q.trim()),
    ]);
    const all = [
      ...nse.map((r: any) => ({
        symbol: String(r.tradingsymbol).replace('-EQ', ''),
        name: String(r.tradingsymbol),
        exchange: 'NSE',
      })),
      ...bse.map((r: any) => ({
        symbol: String(r.tradingsymbol),
        name: String(r.tradingsymbol),
        exchange: 'BSE',
      })),
    ];
    // De-dupe by symbol, prefer NSE
    const seen = new Set<string>();
    const out: { symbol: string; name: string; exchange: string }[] = [];
    for (const r of all) {
      if (seen.has(r.symbol)) continue;
      seen.add(r.symbol);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }
}

export const angel = new AngelOneClient();
