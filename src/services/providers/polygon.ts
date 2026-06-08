/**
 * PolygonProvider — trading-grade US-market data (stocks/options/forex/crypto).
 * Implemented per the multi-provider requirement. NOTE: Polygon does NOT cover
 * Indian NSE/BSE/MCX, so supports() returns false for this app's symbols and it
 * stays inert here; it works for US tickers if ever requested. Enabled by
 * POLYGON_API_KEY.
 */
import { env } from '../../config/env';
import { getJson } from './http';
import { isIndianSymbol } from './symbols';
import {
  MarketDataProvider, ProviderQuote, ProviderCandle, ProviderPeriod, ProviderSearchResult,
} from './types';

const BASE = 'https://api.polygon.io';

export class PolygonProvider implements MarketDataProvider {
  readonly name = 'polygon';
  isConfigured(): boolean { return !!env.POLYGON_API_KEY; }
  // US equities only — never Indian symbols.
  supports(displaySymbol: string): boolean {
    return this.isConfigured() && !isIndianSymbol(displaySymbol);
  }

  async getQuotes(displaySymbols: string[]): Promise<ProviderQuote[]> {
    const syms = displaySymbols.filter((s) => this.supports(s));
    if (!syms.length) return [];
    const now = Date.now();
    const out: ProviderQuote[] = [];
    await Promise.all(syms.map(async (s) => {
      try {
        const b = await getJson(`${BASE}/v2/aggs/ticker/${encodeURIComponent(s.toUpperCase())}/prev?adjusted=true&apiKey=${env.POLYGON_API_KEY}`);
        const r = b?.results?.[0];
        if (!r) return;
        const price = r.c; const prev = r.o ?? r.c;
        out.push({
          symbol: s.toUpperCase(), displaySymbol: s.toUpperCase(),
          price, change: price - prev, changePercent: prev ? ((price - prev) / prev) * 100 : 0,
          previousClose: prev, currency: 'USD', timestamp: now,
        });
      } catch (err: any) { console.error('[polygon] quote error:', err?.message || err); }
    }));
    return out;
  }

  async getHistory(displaySymbol: string, period: ProviderPeriod): Promise<ProviderCandle[]> {
    if (!this.supports(displaySymbol)) return [];
    const plan: Record<ProviderPeriod, { mult: number; span: string; days: number }> = {
      '1D': { mult: 1, span: 'minute', days: 1 },
      '1W': { mult: 5, span: 'minute', days: 7 },
      '1M': { mult: 15, span: 'minute', days: 31 },
      '3M': { mult: 1, span: 'hour', days: 93 },
      '6M': { mult: 1, span: 'day', days: 186 },
      '1Y': { mult: 1, span: 'day', days: 366 },
      '3Y': { mult: 1, span: 'day', days: 1100 },
      '5Y': { mult: 1, span: 'day', days: 1830 },
      'ALL': { mult: 1, span: 'day', days: 3660 },
    };
    const { mult, span, days } = plan[period];
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    try {
      const b = await getJson(
        `${BASE}/v2/aggs/ticker/${encodeURIComponent(displaySymbol.toUpperCase())}/range/${mult}/${span}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${env.POLYGON_API_KEY}`,
        12_000,
      );
      return (b?.results || []).map((r: any) => ({
        time: Math.floor(r.t / 1000), open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v || 0,
      }));
    } catch (err: any) { console.error('[polygon] history error:', err?.message || err); return []; }
  }

  async searchSymbol(query: string): Promise<ProviderSearchResult[]> {
    if (!this.isConfigured()) return [];
    try {
      const b = await getJson(`${BASE}/v3/reference/tickers?search=${encodeURIComponent(query)}&active=true&limit=10&apiKey=${env.POLYGON_API_KEY}`);
      return (b?.results || []).map((r: any) => ({ symbol: r.ticker, name: r.name, exchange: r.primary_exchange }));
    } catch (err: any) { console.error('[polygon] search error:', err?.message || err); return []; }
  }
}
