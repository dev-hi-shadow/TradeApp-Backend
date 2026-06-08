/**
 * TwelveDataProvider — preferred production fallback for NSE cash equities /
 * indices (good free tier, INR-native NSE coverage, simple REST). Enabled by
 * TWELVEDATA_API_KEY. Does NOT cover MCX commodities or Indian option chains —
 * those stay on Angel One.
 */
import { env } from '../../config/env';
import {
  MarketDataProvider,
  ProviderQuote,
  ProviderCandle,
  ProviderPeriod,
  ProviderSearchResult,
} from './types';
import { toYahooSymbol, isEquityOrIndex, isIndianSymbol } from './symbols';
import { getJson } from './http';

const BASE = 'https://api.twelvedata.com';

// Indian indices as Twelve Data symbols (availability varies by plan).
const TD_INDEX: Record<string, string> = {
  NIFTY: 'NIFTY 50',
  'NIFTY 50': 'NIFTY 50',
  BANKNIFTY: 'NIFTY BANK',
  SENSEX: 'SENSEX',
};

export class TwelveDataProvider implements MarketDataProvider {
  readonly name = 'twelvedata';
  private breakerUntil = 0;

  isConfigured(): boolean { return !!env.TWELVEDATA_API_KEY; }
  supports(displaySymbol: string): boolean {
    return this.isConfigured() && isEquityOrIndex(displaySymbol) && isIndianSymbol(displaySymbol);
  }

  /** Display symbol → Twelve Data {symbol, exchange?}. NSE equities use the
   *  bare ticker + exchange=NSE; known indices use their TD index name. */
  private td(displaySymbol: string): { symbol: string; exchange?: string } | null {
    const s = displaySymbol.toUpperCase();
    if (TD_INDEX[s]) return { symbol: TD_INDEX[s] };
    if (isIndianSymbol(s)) return { symbol: s, exchange: 'NSE' };
    return null;
  }

  private open(): boolean { return Date.now() < this.breakerUntil; }
  private maybeTrip(body: any): boolean {
    // TD signals limits via {status:'error', code:429|...}.
    if (body && body.status === 'error' && /run out|api credits|limit/i.test(String(body.message))) {
      if (Date.now() >= this.breakerUntil) console.warn('[twelvedata] rate-limited, breaker open 60s');
      this.breakerUntil = Date.now() + 60_000;
      return true;
    }
    return false;
  }

  async getQuotes(displaySymbols: string[]): Promise<ProviderQuote[]> {
    if (this.open()) return [];
    const targets = displaySymbols
      .filter((s) => this.supports(s))
      .map((s) => ({ display: s.toUpperCase(), td: this.td(s) }))
      .filter((x): x is { display: string; td: { symbol: string; exchange?: string } } => !!x.td);
    if (!targets.length) return [];

    // Group by exchange param so one call can batch many NSE equities.
    const byExch = new Map<string, { display: string; symbol: string }[]>();
    for (const t of targets) {
      const k = t.td.exchange || '';
      const arr = byExch.get(k) || [];
      arr.push({ display: t.display, symbol: t.td.symbol });
      byExch.set(k, arr);
    }
    const out: ProviderQuote[] = [];
    const now = Date.now();
    for (const [exchange, items] of byExch) {
      const symbolParam = encodeURIComponent(items.map((i) => i.symbol).join(','));
      const url =
        `${BASE}/quote?symbol=${symbolParam}` +
        (exchange ? `&exchange=${encodeURIComponent(exchange)}` : '') +
        `&apikey=${env.TWELVEDATA_API_KEY}`;
      try {
        const body = await getJson(url);
        if (this.maybeTrip(body)) continue;
        // Single symbol → flat object; multiple → keyed by symbol.
        const rows: any[] = items.length === 1 ? [body] : Object.values(body);
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          if (!r || r.status === 'error') continue;
          const price = parseFloat(r.close);
          if (!Number.isFinite(price)) continue;
          const prev = parseFloat(r.previous_close);
          const change = Number.isFinite(parseFloat(r.change)) ? parseFloat(r.change) : price - (prev || price);
          const pct = Number.isFinite(parseFloat(r.percent_change))
            ? parseFloat(r.percent_change)
            : prev ? (change / prev) * 100 : 0;
          // Match by symbol when batched; fall back to positional for single.
          const match = items.find((it) => it.symbol.toUpperCase() === String(r.symbol || '').toUpperCase())
            || items[i];
          const display = match?.display || String(r.symbol || '').toUpperCase();
          out.push({
            symbol: toYahooSymbol(display),
            displaySymbol: display,
            price,
            change,
            changePercent: pct,
            previousClose: Number.isFinite(prev) ? prev : price,
            currency: r.currency,
            exchange: r.exchange,
            timestamp: now,
          });
        }
      } catch (err: any) {
        console.error('[twelvedata] quote error:', err?.message || err);
      }
    }
    return out;
  }

  async getHistory(displaySymbol: string, period: ProviderPeriod): Promise<ProviderCandle[]> {
    if (this.open() || !this.supports(displaySymbol)) return [];
    const td = this.td(displaySymbol);
    if (!td) return [];
    const plan: Record<ProviderPeriod, { interval: string; size: number }> = {
      '1D': { interval: '1min', size: 391 },
      '1W': { interval: '5min', size: 600 },
      '1M': { interval: '15min', size: 800 },
      '3M': { interval: '1h', size: 800 },
      '6M': { interval: '1day', size: 130 },
      '1Y': { interval: '1day', size: 260 },
      '3Y': { interval: '1day', size: 780 },
      '5Y': { interval: '1day', size: 1300 },
      'ALL': { interval: '1day', size: 5000 },
    };
    const { interval, size } = plan[period];
    const url =
      `${BASE}/time_series?symbol=${encodeURIComponent(td.symbol)}` +
      (td.exchange ? `&exchange=${encodeURIComponent(td.exchange)}` : '') +
      `&interval=${interval}&outputsize=${size}&order=ASC&apikey=${env.TWELVEDATA_API_KEY}`;
    try {
      const body = await getJson(url, 12_000);
      if (this.maybeTrip(body) || body?.status === 'error') return [];
      const values: any[] = body?.values || [];
      return values
        .map((v) => ({
          time: Math.floor(new Date(v.datetime.replace(' ', 'T')).getTime() / 1000),
          open: parseFloat(v.open),
          high: parseFloat(v.high),
          low: parseFloat(v.low),
          close: parseFloat(v.close),
          volume: v.volume ? parseInt(v.volume, 10) : 0,
        }))
        .filter((c) => Number.isFinite(c.close) && Number.isFinite(c.time));
    } catch (err: any) {
      console.error('[twelvedata] history error:', err?.message || err);
      return [];
    }
  }

  async searchSymbol(query: string): Promise<ProviderSearchResult[]> {
    if (this.open() || !this.isConfigured()) return [];
    const url = `${BASE}/symbol_search?symbol=${encodeURIComponent(query)}&apikey=${env.TWELVEDATA_API_KEY}`;
    try {
      const body = await getJson(url);
      if (this.maybeTrip(body)) return [];
      return (body?.data || [])
        .map((d: any) => ({ symbol: d.symbol, name: d.instrument_name || d.symbol, exchange: d.exchange }))
        .slice(0, 10);
    } catch (err: any) {
      console.error('[twelvedata] search error:', err?.message || err);
      return [];
    }
  }
}
