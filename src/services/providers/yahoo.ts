/**
 * YahooProvider — kept as the LAST-RESORT fallback only (no API key needed).
 * No longer primary: it rate-limits/throttles and isn't production-grade.
 */
import yahooFinance from 'yahoo-finance2';
import {
  MarketDataProvider,
  ProviderQuote,
  ProviderCandle,
  ProviderPeriod,
  ProviderSearchResult,
} from './types';
import { toYahooSymbol, toDisplaySymbol, isEquityOrIndex } from './symbols';

try {
  (yahooFinance as any).suppressNotices?.(['yahooSurvey']);
} catch { /* older versions */ }

export class YahooProvider implements MarketDataProvider {
  readonly name = 'yahoo';
  // 60s circuit breaker: a single 429 means stop hammering for a minute.
  private breakerUntil = 0;

  isConfigured(): boolean { return true; }
  supports(displaySymbol: string): boolean { return isEquityOrIndex(displaySymbol); }

  private open(): boolean { return Date.now() < this.breakerUntil; }
  private trip(msg: string): void {
    if (/too many requests|429/i.test(msg)) {
      if (Date.now() >= this.breakerUntil) console.warn('[yahoo] rate-limited, breaker open 60s');
      this.breakerUntil = Date.now() + 60_000;
    } else {
      console.error('[yahoo] error:', msg);
    }
  }

  async getQuotes(displaySymbols: string[]): Promise<ProviderQuote[]> {
    const eligible = displaySymbols.filter((s) => this.supports(s));
    if (!eligible.length || this.open()) return [];
    const out: ProviderQuote[] = [];
    const yahooSymbols = Array.from(new Set(eligible.map(toYahooSymbol)));
    const now = Date.now();
    try {
      const result: any = await yahooFinance.quote(yahooSymbols);
      const list: any[] = Array.isArray(result) ? result : [result];
      for (const q of list) {
        const px = q?.regularMarketPrice ?? q?.postMarketPrice ?? q?.preMarketPrice;
        if (px == null) continue;
        const prev = q.regularMarketPreviousClose ?? q.previousClose ?? px;
        const change = px - prev;
        out.push({
          symbol: q.symbol,
          displaySymbol: toDisplaySymbol(q.symbol),
          price: px,
          change,
          changePercent: prev ? (change / prev) * 100 : 0,
          previousClose: prev,
          currency: q.currency,
          exchange: q.fullExchangeName,
          timestamp: now,
        });
      }
    } catch (err: any) {
      this.trip(String(err?.message || err));
    }
    // Per-symbol chart fallback for any still missing (chart endpoint is more
    // permissive than the v7 quote endpoint).
    const got = new Set(out.map((q) => q.displaySymbol.toUpperCase()));
    const missing = eligible.filter((s) => !got.has(s.toUpperCase()));
    if (missing.length && !this.open()) {
      const more = await Promise.all(missing.map((s) => this.chartQuote(s)));
      for (const q of more) if (q) out.push(q);
    }
    return out;
  }

  private async chartQuote(displaySymbol: string): Promise<ProviderQuote | null> {
    if (this.open()) return null;
    const yahooSymbol = toYahooSymbol(displaySymbol);
    const now = Date.now();
    try {
      const res: any = await yahooFinance.chart(yahooSymbol, {
        period1: new Date(now - 1000 * 60 * 60 * 24 * 2),
        period2: new Date(now),
        interval: '5m',
      });
      const meta = res?.meta;
      const quotes: any[] = res?.quotes || [];
      const last = [...quotes].reverse().find((q) => q?.close != null);
      const price = last?.close ?? meta?.regularMarketPrice;
      if (price == null) return null;
      const prev = meta?.chartPreviousClose ?? meta?.previousClose ?? price;
      const change = price - prev;
      return {
        symbol: yahooSymbol,
        displaySymbol: toDisplaySymbol(yahooSymbol),
        price, change,
        changePercent: prev ? (change / prev) * 100 : 0,
        previousClose: prev,
        currency: meta?.currency,
        exchange: meta?.exchangeName,
        timestamp: now,
      };
    } catch (err: any) {
      this.trip(String(err?.message || err));
      return null;
    }
  }

  async getHistory(displaySymbol: string, period: ProviderPeriod): Promise<ProviderCandle[]> {
    const yahooSymbol = toYahooSymbol(displaySymbol);
    const now = new Date();
    const period1 = new Date();
    let interval: '1m' | '5m' | '15m' | '1h' | '1d' = '1d';
    switch (period) {
      case '1D': period1.setDate(now.getDate() - 1); interval = '1m'; break;
      case '1W': period1.setDate(now.getDate() - 7); interval = '5m'; break;
      case '1M': period1.setMonth(now.getMonth() - 1); interval = '15m'; break;
      case '3M': period1.setMonth(now.getMonth() - 3); interval = '1h'; break;
      case '6M': period1.setMonth(now.getMonth() - 6); interval = '1d'; break;
      case '1Y': period1.setFullYear(now.getFullYear() - 1); interval = '1d'; break;
      case '3Y': period1.setFullYear(now.getFullYear() - 3); interval = '1d'; break;
      case '5Y': period1.setFullYear(now.getFullYear() - 5); interval = '1d'; break;
      case 'ALL': period1.setFullYear(now.getFullYear() - 10); interval = '1d'; break;
    }
    try {
      const result: any = await yahooFinance.chart(yahooSymbol, { period1, period2: now, interval });
      return (result?.quotes || [])
        .filter((q: any) => q.close != null && q.open != null)
        .map((q: any) => ({
          time: Math.floor(new Date(q.date).getTime() / 1000),
          open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume || 0,
        }));
    } catch (err: any) {
      console.error('[yahoo] history error:', err.message || err);
      return [];
    }
  }

  async searchSymbol(query: string): Promise<ProviderSearchResult[]> {
    try {
      const result: any = await yahooFinance.search(query, { quotesCount: 10 });
      return (result?.quotes || [])
        .filter((x: any) => x.symbol && x.shortname)
        .map((x: any) => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol }));
    } catch (err: any) {
      console.error('[yahoo] search error:', err.message || err);
      return [];
    }
  }
}
