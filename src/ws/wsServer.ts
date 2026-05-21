import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { env } from '../config/env';
import { subscriptionManager } from './subscriptionManager';
import { handleMessage, rawSend, serializeOrder, broadcastPortfolio } from './handlers';
import { fetchQuotes, Quote } from '../services/marketData';
import { executeFill, matchLimitOrders } from '../services/orderEngine';
import { check as checkAlerts } from '../services/alertService';
import keyBy from 'lodash/keyBy';

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
      console.log('[ws] client disconnected. total=', wss.clients.size - 1);
    });
    ws.on('error', (err) => console.error('[ws] error:', err.message));

    rawSend(ws, { type: 'hello', message: 'Send { type: "auth", token } to authenticate.' });
  });

  startPriceLoop();
  return wss;
}

let loopHandle: NodeJS.Timeout | null = null;

function startPriceLoop() {
  if (loopHandle) return;
  loopHandle = setInterval(tickOnce, env.PRICE_TICK_MS);
  console.log('[ws] price loop started @', env.PRICE_TICK_MS, 'ms');
}

async function tickOnce() {
  const symbols = subscriptionManager.allSubscribedSymbols();
  if (symbols.length === 0) return;

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

  // Run alert checks for every fresh price (independent of any subscriber)
  // — fires alertTriggered to owning users via subscriptionManager.
  for (const q of quotes) {
    checkAlerts(q.displaySymbol, q.price).catch((err) =>
      console.error('[alerts] check error:', err.message || err)
    );
  }

  // For each authenticated client, push their relevant quotes + run limit matching
  for (const ctx of subscriptionManager.authenticatedClients()) {
    const relevant: Quote[] = [];
    for (const sym of ctx.subscriptions) {
      const q = bySymbol.get(sym);
      if (q) relevant.push(q);
    }
    if (relevant.length) {
      rawSend(ctx.ws, { type: 'priceUpdate', quotes: relevant });
    }

    // Limit-order matching for each updated symbol
    let portfolioDirty = false;
    for (const q of relevant) {
      const matched = await matchLimitOrders(ctx.userId, q.displaySymbol, q.price);
      for (const order of matched) {
        try {
          const fill = await executeFill(order, q.price);
          rawSend(ctx.ws, {
            type: 'orderFilled',
            order: serializeOrder(fill.order),
            fillPrice: fill.fillPrice,
            newBalance: fill.newBalance,
            position: fill.positionSnapshot,
          });
          portfolioDirty = true;
        } catch (err: any) {
          rawSend(ctx.ws, {
            type: 'orderRejected',
            orderId: order._id.toString(),
            reason: err.message,
          });
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
