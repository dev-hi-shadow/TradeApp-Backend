/**
 * Unit tests for the market-data provider abstraction. Deterministic — no
 * network: the registry chain is swapped for mock providers.
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toYahooSymbol, toDisplaySymbol, isEquityOrIndex, isIndianSymbol } from './symbols';
import {
  providerGetQuotes, providerGetHistory, providerSearch, __setChainForTest,
} from './registry';
import { TwelveDataProvider } from './twelvedata';
import type { MarketDataProvider, ProviderQuote } from './types';

test('symbol helpers map NSE / indices / commodities correctly', () => {
  assert.equal(toYahooSymbol('RELIANCE'), 'RELIANCE.NS');
  assert.equal(toYahooSymbol('NIFTY'), '^NSEI');
  assert.equal(toYahooSymbol('GOLD'), 'GC=F');
  assert.equal(toDisplaySymbol('RELIANCE.NS'), 'RELIANCE');
  assert.equal(toDisplaySymbol('^NSEI'), 'NIFTY 50'); // reverse-alias resolves to the canonical index name
  // equity/index eligible; options/futures/MCX not
  assert.equal(isEquityOrIndex('RELIANCE'), true);
  assert.equal(isEquityOrIndex('NIFTY'), true);
  assert.equal(isEquityOrIndex('NIFTY09JUN2623400PE'), false);
  assert.equal(isEquityOrIndex('GOLD05AUG26FUT'), false);
  assert.equal(isEquityOrIndex('SILVER'), false);
  assert.equal(isIndianSymbol('RELIANCE'), true);
  assert.equal(isIndianSymbol('AAPL.US'), false);
});

// A controllable mock provider.
function mock(
  name: string,
  opts: {
    configured?: boolean;
    supports?: (s: string) => boolean;
    quotes?: (syms: string[]) => ProviderQuote[];
    throwOn?: boolean;
    history?: ProviderQuote extends never ? never : any[];
    search?: { symbol: string; name: string }[];
  } = {},
): MarketDataProvider {
  return {
    name,
    isConfigured: () => opts.configured ?? true,
    supports: (s) => (opts.supports ? opts.supports(s) : true),
    async getQuotes(syms) {
      if (opts.throwOn) throw new Error('boom');
      return opts.quotes ? opts.quotes(syms) : [];
    },
    async getHistory() { return (opts.history as any) || []; },
    async searchSymbol() { return (opts.search as any) || []; },
  };
}

const q = (display: string, price: number): ProviderQuote => ({
  symbol: toYahooSymbol(display), displaySymbol: display, price,
  change: 0, changePercent: 0, previousClose: price, timestamp: Date.now(),
});

test('quotes cascade across providers — each serves what it can, rest fall through', async () => {
  // Primary serves only AAA; secondary (Yahoo-like) serves the rest.
  __setChainForTest([
    mock('primary', { supports: (s) => s === 'AAA', quotes: () => [q('AAA', 100)] }),
    mock('fallback', { quotes: (syms) => syms.map((s) => q(s, 50)) }),
  ]);
  const out = await providerGetQuotes(['AAA', 'BBB', 'CCC']);
  const bySym = Object.fromEntries(out.map((x) => [x.displaySymbol, x.price]));
  assert.equal(bySym['AAA'], 100, 'primary served AAA');
  assert.equal(bySym['BBB'], 50, 'fallback served BBB');
  assert.equal(bySym['CCC'], 50, 'fallback served CCC');
});

test('quotes fail over when a provider throws', async () => {
  __setChainForTest([
    mock('primary', { throwOn: true }),
    mock('fallback', { quotes: (syms) => syms.map((s) => q(s, 7)) }),
  ]);
  const out = await providerGetQuotes(['AAA']);
  assert.equal(out.length, 1);
  assert.equal(out[0].price, 7, 'fell over to the working provider');
});

test('unconfigured providers are skipped', async () => {
  let primaryCalled = false;
  __setChainForTest([
    mock('primary', { configured: false, quotes: () => { primaryCalled = true; return []; } }),
    mock('fallback', { quotes: (syms) => syms.map((s) => q(s, 9)) }),
  ]);
  const out = await providerGetQuotes(['AAA']);
  assert.equal(primaryCalled, false, 'unconfigured provider not called');
  assert.equal(out[0].price, 9);
});

test('history + search: first provider with data wins', async () => {
  __setChainForTest([
    mock('empty', { history: [], search: [] }),
    mock('good', {
      history: [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0 }],
      search: [{ symbol: 'X', name: 'X Corp' }],
    }),
  ]);
  const h = await providerGetHistory('AAA', '1D');
  assert.equal(h.length, 1, 'history from the second provider');
  const s = await providerSearch('x');
  assert.equal(s[0].symbol, 'X');
});

test('TwelveData provider gates on key + symbol type', () => {
  const td = new TwelveDataProvider();
  // Without a key it is not configured and supports nothing.
  if (!td.isConfigured()) {
    assert.equal(td.supports('RELIANCE'), false, 'no key → not supported');
  }
  // Options/MCX are never TD-eligible regardless of key.
  assert.equal(td.supports('NIFTY09JUN2623400PE'), false);
  assert.equal(td.supports('GOLD'), false);
});
