/**
 * Provider-agnostic market-data contract.
 *
 * The app talks to ONE of these (selected by MARKET_DATA_PROVIDER) with an
 * automatic failover chain, instead of being hard-wired to a single vendor.
 * Shapes are structurally identical to marketData's Quote/Candle/Period so a
 * ProviderQuote[] is directly usable where a Quote[] is expected (no mapping).
 *
 * NOTE: this app trades Indian NSE/BSE/MCX + options. Angel One (a real Indian
 * broker) remains the PRIMARY source for everything — these providers only
 * cover the cash-equity / index fallback slice that Yahoo used to serve. No
 * Western vendor offers MCX commodities or Indian option chains.
 */

export interface ProviderQuote {
  symbol: string;          // vendor/Yahoo-style key (kept for cache compatibility)
  displaySymbol: string;   // what users see ("RELIANCE", "NIFTY")
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  currency?: string;
  exchange?: string;
  timestamp: number;
}

export interface ProviderCandle {
  time: number; // epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ProviderPeriod =
  | '1D' | '1W' | '1M' | '3M' | '6M' | '1Y' | '3Y' | '5Y' | 'ALL';

export interface ProviderSearchResult {
  symbol: string;
  name: string;
  exchange?: string;
}

export interface MarketDataProvider {
  /** Stable id used in env / logs (e.g. 'twelvedata'). */
  readonly name: string;
  /** True when the provider has the credentials it needs to run. */
  isConfigured(): boolean;
  /** True when this provider can serve the given display symbol. */
  supports(displaySymbol: string): boolean;
  /** Batch quotes. Returns only the symbols it could resolve. */
  getQuotes(displaySymbols: string[]): Promise<ProviderQuote[]>;
  /** Historical candles for one symbol over a period bucket. */
  getHistory(displaySymbol: string, period: ProviderPeriod): Promise<ProviderCandle[]>;
  /** Symbol search (autocomplete). */
  searchSymbol(query: string): Promise<ProviderSearchResult[]>;
}
