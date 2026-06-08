/**
 * Symbol mapping helpers, shared by the providers and re-exported from
 * marketData for backward compatibility (orderEngine et al. import them from
 * there). Kept in a leaf module so providers can use them without importing
 * marketData (which would create an import cycle).
 */

// Yahoo alias map (Yahoo uses ^NSEI for NIFTY, GC=F for gold, etc.).
const SYMBOL_ALIASES: Record<string, string> = {
  NIFTY: '^NSEI',
  'NIFTY 50': '^NSEI',
  SENSEX: '^BSESN',
  'GIFT NIFTY': 'NIFTY_F1.NS',
  GOLD: 'GC=F',
  SILVER: 'SI=F',
  BANKNIFTY: '^NSEBANK',
};
const REVERSE_ALIAS: Record<string, string> = Object.entries(SYMBOL_ALIASES).reduce(
  (a, [k, v]) => ((a[v] = k), a),
  {} as Record<string, string>,
);

/** Display symbol → Yahoo ticker (e.g. RELIANCE → RELIANCE.NS, NIFTY → ^NSEI). */
export function toYahooSymbol(symbol: string): string {
  const upper = symbol.toUpperCase().trim();
  if (SYMBOL_ALIASES[upper]) return SYMBOL_ALIASES[upper];
  if (/^[A-Z0-9&-]+$/.test(upper) && !upper.includes('.') && !upper.includes('^') && !upper.includes('=')) {
    return `${upper}.NS`;
  }
  return upper;
}

/** Yahoo ticker → display symbol. */
export function toDisplaySymbol(yahooSymbol: string): string {
  if (REVERSE_ALIAS[yahooSymbol]) return REVERSE_ALIAS[yahooSymbol];
  return yahooSymbol.replace('.NS', '').replace('.BO', '');
}

/**
 * Symbols a cash-equity/index REST provider can serve. Options (…CE/…PE),
 * futures (…FUT) and MCX commodities are Angel-only — never route them to a
 * Western provider, it's a guaranteed miss that burns the rate-limit budget.
 */
export function isEquityOrIndex(displaySymbol: string): boolean {
  const s = displaySymbol.toUpperCase();
  if (/\d(?:CE|PE)$/.test(s)) return false; // option contracts
  if (/FUT$/.test(s)) return false;          // futures
  if (/^(GOLD|SILVER|CRUDEOIL|NATURALGAS|COPPER|ZINC|LEAD|ALUMINIUM)/.test(s)) return false; // MCX
  return true;
}

/** Is this a plain Indian-market display symbol (NSE/BSE equity or known index)? */
export function isIndianSymbol(displaySymbol: string): boolean {
  const s = displaySymbol.toUpperCase();
  if (s in SYMBOL_ALIASES) return true;
  // Bare alnum tickers default to NSE in this app.
  return /^[A-Z0-9&-]+$/.test(s) && !s.includes('.') && !s.includes('^') && !s.includes('=');
}
