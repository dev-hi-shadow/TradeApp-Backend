/**
 * Angel One instrument master ("scrip master") loader.
 *
 * - Downloads OpenAPIScripMaster.json (~30 MB) once at startup
 * - Caches to .cache/angel-scripmaster.json (refreshed every 24h)
 * - Filters into indexed maps so option-chain / contract lookups are O(1):
 *     • optionsByUnderlying[NIFTY] = { '20MAR2026': [contract, …], … }
 *     • futuresByUnderlying[NIFTY] = [contract, …]  (sorted by expiry asc)
 *
 * NFO contract record shape:
 *   { token, symbol: "NIFTY20MAR2625400CE", name: "NIFTY",
 *     expiry: "20MAR26",  strike: "2540000" (strike×100 paisa),
 *     instrumenttype: "OPTIDX"|"FUTIDX"|"OPTSTK"|"FUTSTK",
 *     exch_seg: "NFO" }
 */
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const SCRIP_MASTER_URL =
  'https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json';
const CACHE_FILE = path.resolve(process.cwd(), '.cache', 'angel-scripmaster.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ScripInstrument {
  token: string;
  symbol: string;       // e.g. "NIFTY20MAR2625400CE"
  name: string;         // e.g. "NIFTY"
  expiry?: string;      // e.g. "20MAR2026"
  strike?: string;      // value in paisa as string ("2540000" = 25,400)
  exch_seg: string;     // NSE / BSE / NFO / MCX / CDS / BFO
  instrumenttype?: string; // OPTIDX, OPTSTK, FUTIDX, FUTSTK, FUTCOM, ''
  lotsize?: string;
}

export interface OptionContract extends ScripInstrument {
  optType: 'CE' | 'PE';
  strikeValue: number;       // strike in rupees (parsed)
  expiryDate: Date;          // parsed
}

class ScripMaster {
  ready = false;
  loadingPromise: Promise<void> | null = null;
  instruments: ScripInstrument[] = [];

  /** Per-underlying option contracts grouped by expiry string. */
  optionsByUnderlying = new Map<string, Map<string, OptionContract[]>>();
  /** Per-underlying futures sorted by expiry ascending. */
  futuresByUnderlying = new Map<string, OptionContract[]>();

  async ensure(): Promise<void> {
    if (this.ready) return;
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = this.load().finally(() => {
      this.loadingPromise = null;
    });
    return this.loadingPromise;
  }

  private async load(): Promise<void> {
    let raw: any[];
    const stale =
      !fs.existsSync(CACHE_FILE) ||
      Date.now() - fs.statSync(CACHE_FILE).mtimeMs > CACHE_TTL_MS;

    if (!stale) {
      console.log('[scripMaster] loading from disk cache');
      raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } else {
      console.log('[scripMaster] downloading from Angel One…');
      const res = await axios.get(SCRIP_MASTER_URL, {
        timeout: 90_000,
        responseType: 'json',
      });
      raw = res.data;
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(raw));
      console.log(`[scripMaster] downloaded ${raw.length} instruments → cached`);
    }

    this.instruments = raw.map((r: any) => ({
      token: String(r.token),
      symbol: String(r.symbol || ''),
      name: String(r.name || ''),
      expiry: r.expiry || undefined,
      strike: r.strike || undefined,
      exch_seg: String(r.exch_seg || ''),
      instrumenttype: r.instrumenttype || undefined,
      lotsize: r.lotsize || undefined,
    }));

    this.indexOptions();
    this.buildSymbolIndex(); // eager — avoids the lazy empty-map race
    this.ready = true;
  }

  private indexOptions(): void {
    this.optionsByUnderlying.clear();
    this.futuresByUnderlying.clear();
    let optCount = 0;
    let futCount = 0;

    for (const inst of this.instruments) {
      // Only F&O segments
      if (inst.exch_seg !== 'NFO' && inst.exch_seg !== 'BFO') continue;
      const type = inst.instrumenttype || '';

      if (type === 'OPTIDX' || type === 'OPTSTK') {
        // Symbol like NIFTY20MAR2625400CE / RELIANCE20MAR262800PE
        const m = inst.symbol.match(/(CE|PE)$/);
        if (!m) continue;
        const optType = m[1] as 'CE' | 'PE';
        const expiryDate = inst.expiry ? parseExpiry(inst.expiry) : null;
        if (!expiryDate) continue;
        const strikeValue = inst.strike ? parseFloat(inst.strike) / 100 : 0;

        const contract: OptionContract = {
          ...inst,
          optType,
          strikeValue,
          expiryDate,
        };

        const underlying = inst.name.toUpperCase();
        let perExpiry = this.optionsByUnderlying.get(underlying);
        if (!perExpiry) {
          perExpiry = new Map();
          this.optionsByUnderlying.set(underlying, perExpiry);
        }
        const key = formatExpiryKey(expiryDate);
        let list = perExpiry.get(key);
        if (!list) {
          list = [];
          perExpiry.set(key, list);
        }
        list.push(contract);
        optCount++;
      } else if (type === 'FUTIDX' || type === 'FUTSTK' || type === 'FUTCOM') {
        const expiryDate = inst.expiry ? parseExpiry(inst.expiry) : null;
        if (!expiryDate) continue;
        const contract: OptionContract = {
          ...inst,
          optType: 'CE', // placeholder, futures don't really have CE/PE
          strikeValue: 0,
          expiryDate,
        };
        const underlying = inst.name.toUpperCase();
        let list = this.futuresByUnderlying.get(underlying);
        if (!list) {
          list = [];
          this.futuresByUnderlying.set(underlying, list);
        }
        list.push(contract);
        futCount++;
      }
    }

    // Sort each option-strikes list and each futures list
    for (const perExpiry of this.optionsByUnderlying.values()) {
      for (const list of perExpiry.values()) {
        list.sort((a, b) => a.strikeValue - b.strikeValue);
      }
    }
    for (const list of this.futuresByUnderlying.values()) {
      list.sort((a, b) => a.expiryDate.getTime() - b.expiryDate.getTime());
    }
    console.log(`[scripMaster] indexed ${optCount} options · ${futCount} futures`);
  }

  /** All expiry keys for an underlying, sorted ascending. */
  getExpiries(underlying: string, now: number = Date.now()): string[] {
    const map = this.optionsByUnderlying.get(underlying.toUpperCase());
    if (!map) return [];
    const all = Array.from(map.keys()).sort(
      (a, b) => parseExpiryKey(a).getTime() - parseExpiryKey(b).getTime()
    );
    // Drop expiries already SETTLED (past 15:30 IST on their expiry day) — an
    // expired contract has no live quotes, so defaulting the chain to it shows
    // ₹0 across every strike. On expiry day itself it stays listed until 15:30,
    // then rolls to the next live expiry. Fall back to the full list only if
    // somehow nothing is live (so the chain never hard-fails).
    const live = all.filter((k) => isExpiryLive(k, now));
    return live.length ? live : all;
  }

  /**
   * Fuzzy search across NSE & BSE equities (no options/futures/derivatives).
   * Matches the user's query against both `symbol` (e.g. "ETERNAL-EQ") and
   * `name` (e.g. "ETERNAL"). Ranks exact > prefix > substring.
   *
   * Lightning fast — pure in-memory scan over the ~10k cash-equity list.
   */
  searchEquities(query: string, limit = 12): { symbol: string; name: string; exchange: string }[] {
    const q = query.trim().toUpperCase();
    if (!q) return [];

    const matches: { symbol: string; name: string; exchange: string; rank: number }[] = [];
    for (const inst of this.instruments) {
      // Cash equity only — skip F&O/commodity/currency segments
      if (inst.exch_seg !== 'NSE' && inst.exch_seg !== 'BSE') continue;
      // Skip non-equity series (rights/AF/BL/IQ/RL/etc.) for NSE
      if (inst.exch_seg === 'NSE' && inst.symbol && !inst.symbol.endsWith('-EQ')) continue;

      const display = inst.symbol.replace('-EQ', '').toUpperCase();
      const name = (inst.name || '').toUpperCase();

      let rank = 0;
      if (display === q || name === q) rank = 100;
      else if (display.startsWith(q)) rank = 80;
      else if (name.startsWith(q))    rank = 70;
      else if (display.includes(q))   rank = 50;
      else if (name.includes(q))      rank = 40;
      else continue;

      // Slight preference for NSE
      if (inst.exch_seg === 'NSE') rank += 1;

      matches.push({ symbol: display, name: inst.name, exchange: inst.exch_seg, rank });
      // Prune occasionally so we don't accumulate the whole list
      if (matches.length > 500) {
        matches.sort((a, b) => b.rank - a.rank);
        matches.length = 200;
      }
    }
    matches.sort((a, b) => b.rank - a.rank);
    // De-dupe by symbol (NSE wins when both exchanges have it)
    const seen = new Set<string>();
    const out: { symbol: string; name: string; exchange: string }[] = [];
    for (const m of matches) {
      if (seen.has(m.symbol)) continue;
      seen.add(m.symbol);
      out.push({ symbol: m.symbol, name: m.name, exchange: m.exchange });
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * Look up an F&O / commodity contract by its trading symbol — used by
   * inferSegment to learn `instrumenttype` (OPTIDX vs OPTSTK) and by the
   * order engine to learn the lot size at fill time.
   *
   * Built lazily once on first call to avoid bloating `indexOptions()` with
   * a per-symbol map until something actually needs it.
   */
  private _bySymbol: Map<string, ScripInstrument> | null = null;

  /** Build the trading-symbol → instrument index. Called eagerly after load
   *  (so it's never empty once ready) and defensively from the getter. */
  private buildSymbolIndex(): void {
    const map = new Map<string, ScripInstrument>();
    for (const inst of this.instruments) {
      if (inst.symbol) map.set(inst.symbol.toUpperCase(), inst);
    }
    this._bySymbol = map;
  }

  findOptionByTradingSymbol(symbol: string): ScripInstrument | null {
    // Rebuild if never built, OR if a PREVIOUS call built it while the scrip
    // master was still loading (instruments empty → empty map cached forever).
    // That race silently broke lot-size lookup, option quote resolution, and
    // depth warming — everything that resolves an option by its trading symbol.
    if ((!this._bySymbol || this._bySymbol.size === 0) && this.instruments.length > 0) {
      this.buildSymbolIndex();
    }
    return this._bySymbol?.get(symbol.toUpperCase()) ?? null;
  }

  /**
   * Lot size for any tradable symbol. Returns `0` if the symbol is not
   * known to the scrip master (caller should treat as "no enforcement").
   *
   *   • Equity (NSE / BSE)       → 1
   *   • Index / Stock options    → published lot (75 / 30 / 35 / …)
   *   • Futures / Commodity      → published lot
   */
  lotSizeFor(symbol: string): number {
    const s = symbol.toUpperCase();
    const inst = this.findOptionByTradingSymbol(s);
    if (inst && inst.lotsize) {
      const ls = parseInt(String(inst.lotsize), 10);
      if (ls > 0) return ls;
    }
    // Equity series fallback — NSE/BSE cash market has no lot concept (1).
    if (/-EQ$/.test(s) || (!/(\d(?:CE|PE)|FUT)$/.test(s) && this._bySymbol?.has(s + '-EQ'))) {
      return 1;
    }
    return 0;
  }

  /**
   * Returns the option-chain slice: `strikes` × {CE, PE}, centered on `nearStrike`.
   * Default: 21 strikes around ATM.
   */
  getOptionChainSlice(
    underlying: string,
    expiryKey: string,
    nearStrike: number,
    strikeRadius = 10
  ): { strike: number; ce: OptionContract | null; pe: OptionContract | null }[] {
    const perExpiry = this.optionsByUnderlying.get(underlying.toUpperCase());
    if (!perExpiry) return [];
    const list = perExpiry.get(expiryKey);
    if (!list) return [];

    // Group by strike
    const byStrike = new Map<number, { ce: OptionContract | null; pe: OptionContract | null }>();
    for (const c of list) {
      let bucket = byStrike.get(c.strikeValue);
      if (!bucket) {
        bucket = { ce: null, pe: null };
        byStrike.set(c.strikeValue, bucket);
      }
      bucket[c.optType.toLowerCase() as 'ce' | 'pe'] = c;
    }
    const allStrikes = Array.from(byStrike.keys()).sort((a, b) => a - b);
    if (!allStrikes.length) return [];

    // Find ATM index
    let atmIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < allStrikes.length; i++) {
      const d = Math.abs(allStrikes[i] - nearStrike);
      if (d < bestDiff) { bestDiff = d; atmIdx = i; }
    }
    const lo = Math.max(0, atmIdx - strikeRadius);
    const hi = Math.min(allStrikes.length - 1, atmIdx + strikeRadius);
    return allStrikes.slice(lo, hi + 1).map((s) => ({
      strike: s,
      ce: byStrike.get(s)!.ce,
      pe: byStrike.get(s)!.pe,
    }));
  }
}

/**
 * Is this expiry still tradable, i.e. its 15:30 IST settlement is in the future?
 * 15:30 IST == 10:00 UTC. parseExpiry yields local-midnight of the expiry date;
 * we read its calendar y/m/d and rebuild the settlement instant in UTC so the
 * check is timezone-independent of the server clock.
 */
function isExpiryLive(key: string, now: number): boolean {
  const d = parseExpiry(key);
  if (!d) return false;
  const settleMs = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0); // 15:30 IST
  return settleMs > now;
}

// "20MAR2026" → Date(2026, 2, 20).  Also accepts "20MAR26".
function parseExpiry(s: string): Date | null {
  const m = s.match(/(\d{1,2})([A-Z]{3})(\d{2,4})/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const month = months[m[2].toUpperCase()];
  if (month == null) return null;
  let yr = parseInt(m[3], 10);
  if (yr < 100) yr += 2000;
  return new Date(yr, month, day);
}

// 2026-03-20 → "20MAR2026"  (matches Angel's expiry field)
function formatExpiryKey(d: Date): string {
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  return `${String(d.getDate()).padStart(2, '0')}${months[d.getMonth()]}${d.getFullYear()}`;
}
function parseExpiryKey(s: string): Date {
  return parseExpiry(s) || new Date(0);
}

export const scripMaster = new ScripMaster();
