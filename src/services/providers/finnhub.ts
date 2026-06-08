/**
 * FinnhubProvider — real-time US quotes + company data. Implemented per the
 * multi-provider requirement. Like Polygon, it does NOT cover Indian NSE/BSE/
 * MCX, so supports() is false for this app's symbols (inert here; works for US
 * tickers). Enabled by FINNHUB_API_KEY.
 */
import { env } from '../../config/env';
import { getJson } from './http';
import { isIndianSymbol } from './symbols';
import {
  MarketDataProvider, ProviderQuote, ProviderCandle, ProviderPeriod, ProviderSearchResult,
} from './types';

const BASE = 'https://finnhub.io/api/v1';

export class FinnhubProvider implements MarketDataProvider {
  readonly name = 'finnhub';
  isConfigured(): boolean { return !!env.FINNHUB_API_KEY; }
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
        const r = await getJson(`${BASE}/quote?symbol=${encodeURIComponent(s.toUpperCase())}&token=${env.FINNHUB_API_KEY}`);
        if (r?.c == null || r.c === 0) return;
        const price = r.c; const prev = r.pc ?? price;
        out.push({
          symbol: s.toUpperCase(), displaySymbol: s.toUpperCase(),
          price, change: r.d ?? price - prev, changePercent: r.dp ?? (prev ? ((price - prev) / prev) * 100 : 0),
          previousClose: prev, currency: 'USD', timestamp: now,
        });
      } catch (err: any) { console.error('[finnhub] quote error:', err?.message || err); }
    }));
    return out;
  }

  async getHistory(displaySymbol: string, period: ProviderPeriod): Promise<ProviderCandle[]> {
    if (!this.supports(displaySymbol)) return [];
    const plan: Record<ProviderPeriod, { res: string; days: number }> = {
      '1D': { res: '1', days: 1 }, '1W': { res: '5', days: 7 }, '1M': { res: '15', days: 31 },
      '3M': { res: '60', days: 93 }, '6M': { res: 'D', days: 186 }, '1Y': { res: 'D', days: 366 },
      '3Y': { res: 'D', days: 1100 }, '5Y': { res: 'W', days: 1830 }, 'ALL': { res: 'W', days: 3660 },
    };
    const { res, days } = plan[period];
    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 86400;
    try {
      const b = await getJson(
        `${BASE}/stock/candle?symbol=${encodeURIComponent(displaySymbol.toUpperCase())}&resolution=${res}&from=${from}&to=${to}&token=${env.FINNHUB_API_KEY}`,
        12_000,
      );
      if (b?.s !== 'ok' || !Array.isArray(b.t)) return [];
      return b.t.map((time: number, i: number) => ({
        time, open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i], volume: b.v?.[i] || 0,
      }));
    } catch (err: any) { console.error('[finnhub] history error:', err?.message || err); return []; }
  }

  async searchSymbol(query: string): Promise<ProviderSearchResult[]> {
    if (!this.isConfigured()) return [];
    try {
      const b = await getJson(`${BASE}/search?q=${encodeURIComponent(query)}&token=${env.FINNHUB_API_KEY}`);
      return (b?.result || []).slice(0, 10).map((r: any) => ({ symbol: r.symbol, name: r.description || r.symbol }));
    } catch (err: any) { console.error('[finnhub] search error:', err?.message || err); return []; }
  }
}
