import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { env, angelFeedEnabled } from '../config/env';
import { subscriptionManager } from './subscriptionManager';
import { handleMessage, rawSend, serializeOrder, broadcastPortfolio } from './handlers';
import { fetchQuotes, warmDepth, Quote } from '../services/marketData';
import { syncFeedSubscriptions } from '../services/feedSync';
import { processRestingOrders, symbolsWithRestingOrders, symbolsWithOpenPositions, isSymbolTradingOpen, RestingFillEvent } from '../services/orderEngine';
import { processPositionGuards, symbolsWithGuards, GuardEvent } from '../services/positionGuard';
import { check as checkAlerts } from '../services/alertService';
import { sendPushToUser } from '../services/push';
import keyBy from 'lodash/keyBy';
import uniq from 'lodash/uniq';

export function attachWebSocketServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    const ctx = subscriptionManager.register(ws);
    console.log('[ws] client connected. total=', wss.clients.size);

    // Hard limit: client must authenticate within 10s
    const authTimer = setTimeout(() => {
      if (!ctx.authenticated) {
        rawSend(ws, { type: 'authResult', ok: false, error: 'Auth timeout' });
        ws.close();
      }
    }, 10_000);

    ws.on('message', (raw) => handleMessage(ws, raw).catch((e) => console.error('[ws] msg err', e)));
    ws.on('close', () => {
      clearTimeout(authTimer);
      subscriptionManager.remove(ws);
      // `ws` is already out of wss.clients by the time this fires on newer
      // ws versions, so the size IS the post-disconnect count. Clamp at 0
      // to defend against the (-1) we were printing previously.
      console.log('[ws] client disconnected. total=', Math.max(0, wss.clients.size));
    });
    ws.on('error', (err) => console.error('[ws] error:', err.message));

    rawSend(ws, { type: 'hello', message: 'Send { type: "auth", token } to authenticate.' });
  });

  startPriceLoop();
  return wss;
}

let loopHandle: NodeJS.Timeout | null = null;
// Re-entrancy guard. If a tick is slower than PRICE_TICK_MS (rate-limit
// backoff, slow upstream, GC pause) the next interval would stack a fresh
// `tickOnce` on top of the still-running one — which then re-hits Angel,
// deepens the rate-limit storm, and so on. Skip the new tick instead.
let tickInFlight = false;

function startPriceLoop() {
  if (loopHandle) return;
  loopHandle = setInterval(() => {
    if (tickInFlight) return;
    tickInFlight = true;
    tickOnce()
      .catch((err) => console.error('[ws] tick error:', err.message || err))
      .finally(() => { tickInFlight = false; });
  }, env.PRICE_TICK_MS);
  console.log('[ws] price loop started @', env.PRICE_TICK_MS, 'ms');
}

async function tickOnce() {
  // Price the union of (a) everything any client is watching and (b) every
  // symbol with a RESTING order — so limit/SL orders fill even when their
  // owner is disconnected (they have no subscription driving the price).
  const subscribed = subscriptionManager.allSubscribedSymbols();
  let resting: string[] = [];
  let guarded: string[] = [];
  let openPos: string[] = [];
  try {
    [resting, guarded, openPos] = await Promise.all([
      symbolsWithRestingOrders(),
      symbolsWithGuards(),
      symbolsWithOpenPositions(),
    ]);
  } catch (err: any) {
    console.error('[ws] resting/guard/position-symbol scan error:', err.message || err);
  }
  const symbols = uniq([
    ...subscribed,
    ...resting.map((s) => s.toUpperCase()),
    ...guarded.map((s) => s.toUpperCase()),
    ...openPos.map((s) => s.toUpperCase()),
  ]);
  if (symbols.length === 0) return;

  // Drive the single Angel SmartWebSocketV2 feed's subscription set from the
  // same union the loop prices. When the feed is enabled, live ticks keep the
  // quote cache hot so the fetchQuotes() below serves cache hits instead of
  // hitting Angel REST. Fire-and-forget + self-throttled; no-op when disabled.
  if (angelFeedEnabled) {
    syncFeedSubscriptions(symbols).catch((err) =>
      console.error('[ws] feed sync error:', err?.message || err),
    );
  }

  // Keep the depth cache WARM for everything that can be FILLED (resting/SL
  // orders, guarded positions, open positions to exit). Fire-and-forget so the
  // tick never blocks on the (throttle-prone) FULL-mode call — the cache-only
  // fill path then walks the REAL order book against real volume instead of
  // the synthetic fallback. Manual entries are warmed separately by the order
  // preview route. Self-throttles via warmDepth's freshness window.
  warmDepth(uniq([
    ...resting.map((s) => s.toUpperCase()),
    ...guarded.map((s) => s.toUpperCase()),
    ...openPos.map((s) => s.toUpperCase()),
  ])).catch((err) => console.error('[ws] warmDepth error:', err?.message || err));

  let quotes: Quote[] = [];
  try {
    quotes = await fetchQuotes(symbols);
  } catch (err: any) {
    console.error('[ws] tick fetch error:', err.message);
    return;
  }
  if (quotes.length === 0) return;

  // Build map for easy per-client filtering — lodash.keyBy is the cleanest
  // way to index by an uppercased display symbol in a single pass.
  const bySymbolObj = keyBy(quotes, (q) => q.displaySymbol.toUpperCase());
  const bySymbol = new Map<string, Quote>(Object.entries(bySymbolObj));

  // Only symbols that ACTUALLY have resting orders / guards need the per-symbol
  // matcher queries below. Without this gate every subscribed symbol cost two
  // sequential Mongo round-trips per tick — invisible with a local DB, but with
  // a remote Atlas (~250ms RTT) it ballooned ticks to many seconds and the
  // re-entrancy guard then dropped ticks (slow live prices in production).
  const restingSet = new Set(resting.map((s) => s.toUpperCase()));
  const guardedSet = new Set(guarded.map((s) => s.toUpperCase()));

  // Run alert checks for every fresh price (independent of any subscriber)
  // — fires alertTriggered to owning users via subscriptionManager.
  for (const q of quotes) {
    checkAlerts(q.displaySymbol, q.price).catch((err) =>
      console.error('[alerts] check error:', err.message || err)
    );
  }

  // ── Global, server-side order matching (once per symbol per tick) ──
  // Fills happen regardless of who's connected; we collect events per user so
  // we can notify any of their live sockets afterwards.
  const eventsByUser = new Map<string, RestingFillEvent[]>();
  const guardsByUser = new Map<string, GuardEvent[]>();
  for (const q of quotes) {
    // Market-hours gate: NEVER match resting orders or fire SL/target guards on
    // stale post-close prices. When the market reopens (9:15 NSE / 9:00 MCX) the
    // first live ticks evaluate any crossed levels → deferred fills execute then.
    if (!isSymbolTradingOpen(q.displaySymbol)) continue;
    const SYM = q.displaySymbol.toUpperCase();
    // Resting limit/SL orders — only for symbols that actually have any.
    if (restingSet.has(SYM)) {
      try {
        for (const ev of await processRestingOrders(q.displaySymbol, q.price)) {
          const arr = eventsByUser.get(ev.userId) || [];
          arr.push(ev);
          eventsByUser.set(ev.userId, arr);
        }
      } catch (err: any) {
        console.error('[ws] matcher error:', err.message || err);
      }
    }
    // Position guards (SL / target / trailing auto-exit) — same gating.
    if (guardedSet.has(SYM)) {
      try {
        for (const gev of await processPositionGuards(q.displaySymbol, q.price)) {
          const arr = guardsByUser.get(gev.userId) || [];
          arr.push(gev);
          guardsByUser.set(gev.userId, arr);
        }
      } catch (err: any) {
        console.error('[ws] guard error:', err.message || err);
      }
    }
  }

  // ── Web push (fires even if the user has NO socket open) ──
  // Resting limit/SL orders that just FULLY filled, and guard auto-exits.
  for (const [userId, evs] of eventsByUser) {
    for (const ev of evs) {
      if (ev.kind === 'filled' && ev.fill && ev.fill.order.status === 'filled') {
        const o = ev.fill.order;
        sendPushToUser(userId, {
          title: `Order filled · ${o.symbol}`,
          body: `${o.side.toUpperCase()} ${o.quantity} @ ₹${ev.fill.fillPrice.toFixed(2)}`,
          tag: `order-${o._id.toString()}`,
          url: '/trade',
        }).catch(() => {});
      }
    }
  }
  for (const [userId, gevs] of guardsByUser) {
    for (const gev of gevs) {
      if (gev.kind === 'triggered' && gev.fill) {
        const pnl = gev.fill.positionSnapshot?.realisedPnL;
        sendPushToUser(userId, {
          title: `${gev.reason} hit · ${gev.symbol}`,
          body: `Auto-exited @ ₹${gev.fill.fillPrice.toFixed(2)}${pnl != null ? ` · realised ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)}` : ''}`,
          tag: `guard-${gev.symbol}-${gev.product}`,
          url: '/trade',
        }).catch(() => {});
      }
    }
  }

  // For each authenticated client: push their relevant quotes, deliver any
  // fills/cancels for their user, and refresh their portfolio.
  for (const ctx of subscriptionManager.authenticatedClients()) {
    const relevant: Quote[] = [];
    for (const sym of ctx.subscriptions) {
      const q = bySymbol.get(sym);
      if (q) relevant.push(q);
    }
    if (relevant.length) {
      rawSend(ctx.ws, { type: 'priceUpdate', quotes: relevant });
    }

    let portfolioDirty = false;
    const userEvents = eventsByUser.get(ctx.userId.toString());
    if (userEvents && userEvents.length) {
      for (const ev of userEvents) {
        if (ev.kind === 'filled' && ev.fill) {
          rawSend(ctx.ws, {
            type: 'orderFilled',
            order: serializeOrder(ev.fill.order),
            fillPrice: ev.fill.fillPrice,
            newBalance: ev.fill.newBalance,
            position: ev.fill.positionSnapshot,
          });
          portfolioDirty = true;
        } else if (ev.kind === 'cancelled') {
          rawSend(ctx.ws, { type: 'orderCancelled', order: serializeOrder(ev.order) });
        } else if (ev.kind === 'rejected') {
          rawSend(ctx.ws, {
            type: 'orderRejected',
            orderId: ev.order._id.toString(),
            reason: ev.reason,
          });
        }
      }
    }

    // Deliver any position-guard (SL/target/trailing) auto-exits.
    const guardEvents = guardsByUser.get(ctx.userId.toString());
    if (guardEvents && guardEvents.length) {
      for (const gev of guardEvents) {
        if (gev.kind === 'triggered' && gev.fill) {
          rawSend(ctx.ws, {
            type: 'guardTriggered',
            reason: gev.reason,
            symbol: gev.symbol,
            product: gev.product,
            fillPrice: gev.fill.fillPrice,
            realisedPnL: gev.fill.positionSnapshot?.realisedPnL ?? null,
          });
          rawSend(ctx.ws, {
            type: 'orderFilled',
            order: serializeOrder(gev.fill.order),
            fillPrice: gev.fill.fillPrice,
            newBalance: gev.fill.newBalance,
            position: gev.fill.positionSnapshot,
          });
          portfolioDirty = true;
        }
      }
    }

    // Push a live portfolio snapshot:
    //   • Always after a fill (dirty)
    //   • Otherwise at most every 2 seconds while the user has at least one
    //     touched price — this keeps `availableMargin` & `unrealisedPnL`
    //     fresh in the UI without spamming the wire.
    const now = Date.now();
    const lastPushed = (ctx as any).__lastPortfolioPush ?? 0;
    const dueForTickPush = relevant.length > 0 && now - lastPushed >= 2000;
    if (portfolioDirty || dueForTickPush) {
      try {
        await broadcastPortfolio(ctx);
        (ctx as any).__lastPortfolioPush = now;
      } catch (err: any) {
        console.error('[ws] portfolio broadcast err:', err.message);
      }
    }
  }
}
