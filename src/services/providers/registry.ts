/**
 * Market-data provider registry + failover.
 *
 * The primary provider is chosen by MARKET_DATA_PROVIDER (default: twelvedata).
 * Calls walk a chain — primary → explicit MARKET_DATA_FALLBACK list → the rest
 * → Yahoo LAST (Yahoo is demoted to a no-key safety net, never primary). Only
 * configured providers that `supports()` a symbol are tried, so e.g. NSE
 * equities go to Twelve Data while Yahoo backstops anything it misses.
 *
 * This layer covers the cash-equity / index slice only. Angel One remains the
 * primary source for everything (MCX, options, futures) in marketData.ts.
 */
import { env } from '../../config/env';
import {
  MarketDataProvider, ProviderQuote, ProviderCandle, ProviderPeriod, ProviderSearchResult,
} from './types';
import { YahooProvider } from './yahoo';
import { TwelveDataProvider } from './twelvedata';
import { PolygonProvider } from './polygon';
import { FinnhubProvider } from './finnhub';

const providers: Record<string, MarketDataProvider> = {
  twelvedata: new TwelveDataProvider(),
  polygon: new PolygonProvider(),
  finnhub: new FinnhubProvider(),
  yahoo: new YahooProvider(),
};

function buildChain(): MarketDataProvider[] {
  const primary = (env.MARKET_DATA_PROVIDER || 'twelvedata').toLowerCase();
  const fallbacks = (env.MARKET_DATA_FALLBACK || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  // primary, then explicit fallbacks, then everything else, with Yahoo LAST.
  const order = [primary, ...fallbacks, 'twelvedata', 'polygon', 'finnhub', 'yahoo'];
  const seen = new Set<string>();
  const chain: MarketDataProvider[] = [];
  for (const n of order) {
    if (providers[n] && !seen.has(n)) { seen.add(n); chain.push(providers[n]); }
  }
  return chain;
}

let chain = buildChain();

/** Re-read env (used by tests). */
export function rebuildProviderChain(): void { chain = buildChain(); }
/** Test-only: swap the active chain with mock providers. */
export function __setChainForTest(c: MarketDataProvider[]): void { chain = c; }
/** Names of providers that are configured + in the active chain (for logs/health). */
export function activeProviders(): { primary: string; configured: string[] } {
  return {
    primary: chain[0]?.name ?? 'none',
    configured: chain.filter((p) => p.isConfigured()).map((p) => p.name),
  };
}

/**
 * Batch quotes with failover: each provider serves the symbols it supports;
 * anything still unresolved cascades to the next provider (Yahoo last).
 */
export async function providerGetQuotes(displaySymbols: string[]): Promise<ProviderQuote[]> {
  const remaining = new Set(displaySymbols.map((s) => s.toUpperCase()));
  const out: ProviderQuote[] = [];
  for (const p of chain) {
    if (!remaining.size) break;
    if (!p.isConfigured()) continue;
    const want = [...remaining].filter((s) => p.supports(s));
    if (!want.length) continue;
    try {
      const got = await p.getQuotes(want);
      for (const q of got) {
        out.push(q);
        remaining.delete(q.displaySymbol.toUpperCase());
      }
    } catch (err: any) {
      console.error(`[providers] ${p.name} getQuotes failed:`, err?.message || err);
    }
  }
  return out;
}

/** Historical candles: first configured provider that supports + returns data wins. */
export async function providerGetHistory(
  displaySymbol: string,
  period: ProviderPeriod,
): Promise<ProviderCandle[]> {
  for (const p of chain) {
    if (!p.isConfigured() || !p.supports(displaySymbol)) continue;
    try {
      const candles = await p.getHistory(displaySymbol, period);
      if (candles.length) return candles;
    } catch (err: any) {
      console.error(`[providers] ${p.name} getHistory failed:`, err?.message || err);
    }
  }
  return [];
}

/** Symbol search: first configured provider that returns results wins. */
export async function providerSearch(query: string): Promise<ProviderSearchResult[]> {
  for (const p of chain) {
    if (!p.isConfigured()) continue;
    try {
      const r = await p.searchSymbol(query);
      if (r.length) return r;
    } catch (err: any) {
      console.error(`[providers] ${p.name} search failed:`, err?.message || err);
    }
  }
  return [];
}
