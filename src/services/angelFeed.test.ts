/**
 * Unit tests for the single Angel SmartWebSocketV2 feed. Run with:
 *   npm test            (tsx --test)
 *
 * No live Angel connection is used — the socket and credential provider are
 * injected, so we deterministically test: exchange mapping, binary parsing,
 * subscribe/unsubscribe diffing (no duplicates, cleanup on last leave),
 * resubscribe-on-reconnect, and tick routing into the quote cache.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AngelFeed,
  exchangeTypeFor,
  parseTickPackets,
  type SocketLike,
} from './angelFeed';
import { getLatestCached, toYahooSymbol } from './marketData';

// ---- A controllable fake socket implementing SocketLike ----
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  private handlers: Record<string, ((...a: any[]) => void)[]> = {};
  on(ev: string, cb: (...a: any[]) => void): this {
    (this.handlers[ev] ||= []).push(cb);
    return this as any;
  }
  send(d: any): void { this.sent.push(String(d)); }
  close(): void { this.readyState = 3; this.fire('close'); }
  fire(ev: string, ...args: any[]) { (this.handlers[ev] || []).forEach((cb) => cb(...args)); }
  open() { this.readyState = 1; this.fire('open'); }
}

const FAKE_CREDS = async () => ({
  jwtToken: 'jwt', feedToken: 'feed', apiKey: 'key', clientCode: 'CL',
});

const tick = () => new Promise((r) => setImmediate(r));

function subs(sock: FakeSocket) {
  return sock.sent
    .filter((s) => s.startsWith('{'))
    .map((s) => JSON.parse(s))
    .filter((m) => m.action === 1)
    .flatMap((m) => m.params.tokenList.flatMap((t: any) => t.tokens));
}
function unsubs(sock: FakeSocket) {
  return sock.sent
    .filter((s) => s.startsWith('{'))
    .map((s) => JSON.parse(s))
    .filter((m) => m.action === 0)
    .flatMap((m) => m.params.tokenList.flatMap((t: any) => t.tokens));
}

test('exchangeTypeFor maps known exchanges and rejects unknowns', () => {
  assert.equal(exchangeTypeFor('NSE'), 1);
  assert.equal(exchangeTypeFor('nfo'), 2);
  assert.equal(exchangeTypeFor('MCX'), 5);
  assert.equal(exchangeTypeFor('BSE'), 3);
  assert.equal(exchangeTypeFor('CDS'), 13);
  assert.equal(exchangeTypeFor('FOO'), null);
});

test('parseTickPackets parses a Quote-mode binary packet', () => {
  const buf = Buffer.alloc(123);
  buf[0] = 2;             // mode = Quote
  buf[1] = 1;             // exchangeType = nse_cm
  buf.write('26009', 2, 'ascii'); // token
  buf.writeBigInt64LE(2325050n, 43);  // ltp paise → 23250.50
  buf.writeBigInt64LE(12345n, 67);    // volume
  buf.writeBigInt64LE(2320000n, 115); // close paise → 23200.00
  const [t] = parseTickPackets(buf);
  assert.equal(t.exchangeType, 1);
  assert.equal(t.token, '26009');
  assert.equal(t.ltp, 23250.5);
  assert.equal(t.close, 23200);
  assert.equal(t.volume, 12345);
});

test('parseTickPackets handles two concatenated packets', () => {
  const mk = (token: string, paise: bigint) => {
    const b = Buffer.alloc(123);
    b[0] = 2; b[1] = 1; b.write(token, 2, 'ascii'); b.writeBigInt64LE(paise, 43);
    return b;
  };
  const ticks = parseTickPackets(Buffer.concat([mk('111', 10000n), mk('222', 20000n)]));
  assert.equal(ticks.length, 2);
  assert.equal(ticks[0].token, '111');
  assert.equal(ticks[1].ltp, 200);
});

test('subscribe/unsubscribe diffing: no duplicates, cleanup on last leave', async () => {
  const created: FakeSocket[] = [];
  const feed = new AngelFeed({
    factory: () => { const s = new FakeSocket(); created.push(s); return s; },
    getCreds: FAKE_CREDS,
  });

  feed.setDesired([{ displaySymbol: 'AAA', exchange: 'NSE', exchangeType: 1, token: 'A' }]);
  await tick();
  const sock = created[0];
  sock.open();
  assert.deepEqual(subs(sock), ['A'], 'initial subscribe sends A');

  // Add B → only B is sent (no duplicate A).
  feed.setDesired([
    { displaySymbol: 'AAA', exchange: 'NSE', exchangeType: 1, token: 'A' },
    { displaySymbol: 'BBB', exchange: 'NSE', exchangeType: 1, token: 'B' },
  ]);
  assert.deepEqual(subs(sock), ['A', 'B']);

  // Drop A (B remains) → A is UNSUBSCRIBED (auto-cleanup of departed token).
  feed.setDesired([{ displaySymbol: 'BBB', exchange: 'NSE', exchangeType: 1, token: 'B' }]);
  assert.deepEqual(unsubs(sock), ['A']);
  assert.equal(feed.status().desired, 1);

  feed.stop();
});

test('resubscribes the full desired set after reconnect', async () => {
  const created: FakeSocket[] = [];
  const feed = new AngelFeed({
    factory: () => { const s = new FakeSocket(); created.push(s); return s; },
    getCreds: FAKE_CREDS,
  });
  feed.setDesired([
    { displaySymbol: 'AAA', exchange: 'NSE', exchangeType: 1, token: 'A' },
    { displaySymbol: 'BBB', exchange: 'NSE', exchangeType: 1, token: 'B' },
  ]);
  await tick();
  created[0].open();
  assert.deepEqual(subs(created[0]).sort(), ['A', 'B']);

  // Drop the socket → feed schedules a reconnect; force a fresh connect.
  created[0].close();
  feed.ensureConnected();
  await tick();
  const sock2 = created[created.length - 1];
  assert.notEqual(sock2, created[0], 'a new socket was created');
  sock2.open();
  assert.deepEqual(subs(sock2).sort(), ['A', 'B'], 'full set resubscribed on reconnect');

  feed.stop();
});

test('routes a parsed tick into the quote cache via injectLiveQuote', async () => {
  const created: FakeSocket[] = [];
  const feed = new AngelFeed({
    factory: () => { const s = new FakeSocket(); created.push(s); return s; },
    getCreds: FAKE_CREDS,
  });
  feed.setDesired([{ displaySymbol: 'ZZTEST', exchange: 'NSE', exchangeType: 1, token: '99999' }]);
  await tick();
  created[0].open();

  const buf = Buffer.alloc(123);
  buf[0] = 2; buf[1] = 1; buf.write('99999', 2, 'ascii');
  buf.writeBigInt64LE(123450n, 43); // 1234.50
  buf.writeBigInt64LE(120000n, 115); // close 1200.00
  created[0].fire('message', buf, true);

  const q = getLatestCached(toYahooSymbol('ZZTEST'));
  assert.ok(q, 'quote was injected into the cache');
  assert.equal(q!.price, 1234.5);
  assert.equal(q!.previousClose, 1200);
  assert.ok(q!.change > 0);

  feed.stop();
});
