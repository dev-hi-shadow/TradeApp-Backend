import WebSocket from 'ws';
import { Types } from 'mongoose';
import { ClientCtx, subscriptionManager } from './subscriptionManager';
import { verifyToken } from '../utils/jwt';
import { User } from '../models/User';
import { Order } from '../models/Order';
import { Position } from '../models/Position';
import { Watchlist } from '../models/Watchlist';
import { executeFill, computePortfolio, lookupLotSize, marketFillPrice, closePositions, isSymbolTradingOpen, marketStatusForSymbol } from '../services/orderEngine';
import { fetchQuotes, getLatestCached, toYahooSymbol, Quote } from '../services/marketData';
import { angel } from '../services/angelOne';
import { scripMaster } from '../services/scripMaster';
import { cacheGet, cacheSet } from '../services/cache';

/**
 * Symbols that have no cash market — only F&O — per NSE / MCX rules.
 * Mirrors the frontend's DERIVATIVES_ONLY set in StockDetail.tsx.
 */
const DERIVATIVES_ONLY = new Set([
  // NSE indices
  'NIFTY', 'NIFTY50', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50',
  // BSE indices
  'SENSEX', 'BANKEX',
  // MCX commodity friendly names
  'GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM',
]);

/**
 * Resolve the LTP for a tradable symbol. For cash/index symbols we go through
 * the standard `fetchQuotes` path (Angel display-symbol resolver → Yahoo
 * fallback). For OPTION CONTRACTS (NIFTY26MAY2623650CE) that path returns
 * nothing because Angel only indexes underlying display symbols, so we
 * resolve the contract via the scrip master and hit the token-quote API
 * directly.
 */
async function resolveQuote(symbol: string): Promise<Quote | null> {
  const cached = getLatestCached(toYahooSymbol(symbol));
  if (cached) return cached;

  const fresh = await fetchQuotes([symbol]);
  if (fresh.length) return fresh[0];

  // Option contract fallback — look up token in scripMaster, hit FULL mode.
  if (/\d(?:CE|PE)$/.test(symbol.toUpperCase())) {
    const inst = scripMaster.findOptionByTradingSymbol?.(symbol);
    if (!inst) return null;
    try {
      const rows = await angel.getQuotesByTokens(
        [{ exchange: inst.exch_seg, token: inst.token }],
        'FULL',
      );
      const r = rows?.[0];
      if (!r || !r.ltp) return null;
      return {
        symbol: symbol.toUpperCase(),
        displaySymbol: symbol.toUpperCase(),
        price: Number(r.ltp),
        change: Number(r.netChange ?? 0),
        changePercent: Number(r.percentChange ?? 0),
        previousClose: Number(r.close ?? 0),
        exchange: inst.exch_seg,
        timestamp: Date.now(),
      };
    } catch (err: any) {
      console.error('[resolveQuote] option-token fetch failed:', err.message || err);
      return null;
    }
  }
  return null;
}

export type WSMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; symbols: string[]; reqId?: string }
  | { type: 'unsubscribe'; symbols: string[]; reqId?: string }
  | { type: 'placeOrder'; reqId?: string; order: { symbol: string; type: 'market' | 'limit' | 'sl' | 'sl-m'; side: 'buy' | 'sell'; quantity: number; price?: number; triggerPrice?: number; validity?: 'DAY' | 'IOC' | 'GTT'; product?: 'CNC' | 'MIS' | 'NRML'; planId?: string; bracketStopLoss?: number; bracketTarget?: number } }
  | { type: 'cancelOrder'; reqId?: string; orderId: string }
  | { type: 'modifyOrder'; reqId?: string; orderId: string; price?: number; triggerPrice?: number; quantity?: number }
  | { type: 'exitPosition'; reqId?: string; symbol: string; product?: 'CNC' | 'MIS' | 'NRML' }
  | { type: 'exitAll'; reqId?: string }
  | { type: 'updateWatchlist'; reqId?: string; symbols: string[] }
  | { type: 'ping'; reqId?: string };

function send(ws: WebSocket, payload: unknown) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendError(ws: WebSocket, reqId: string | undefined, message: string) {
  send(ws, { type: 'error', reqId, message });
}

export async function handleMessage(ws: WebSocket, raw: WebSocket.RawData): Promise<void> {
  const ctx = subscriptionManager.get(ws);
  if (!ctx) return;

  let msg: WSMessage;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return sendError(ws, undefined, 'Invalid JSON');
  }

  if (msg.type === 'auth') {
    return handleAuth(ctx, msg.token);
  }

  if (!ctx.authenticated) {
    return sendError(ws, (msg as any).reqId, 'Not authenticated');
  }

  switch (msg.type) {
    case 'subscribe':
      return handleSubscribe(ctx, msg.symbols, msg.reqId);
    case 'unsubscribe':
      return handleUnsubscribe(ctx, msg.symbols, msg.reqId);
    case 'placeOrder':
      return handlePlaceOrder(ctx, msg.order, msg.reqId);
    case 'cancelOrder':
      return handleCancelOrder(ctx, msg.orderId, msg.reqId);
    case 'modifyOrder':
      return handleModifyOrder(ctx, msg, msg.reqId);
    case 'exitPosition':
      return handleExit(ctx, { symbol: msg.symbol, product: msg.product }, msg.reqId);
    case 'exitAll':
      return handleExit(ctx, {}, msg.reqId);
    case 'updateWatchlist':
      return handleUpdateWatchlist(ctx, msg.symbols, msg.reqId);
    case 'ping':
      return send(ws, { type: 'pong', reqId: msg.reqId, t: Date.now() });
    default:
      return sendError(ws, (msg as any).reqId, `Unknown message type: ${(msg as any).type}`);
  }
}

async function handleAuth(ctx: ClientCtx, token: string): Promise<void> {
  const payload = verifyToken(token);
  if (!payload) {
    send(ctx.ws, { type: 'authResult', ok: false, error: 'Invalid token' });
    ctx.ws.close();
    return;
  }
  const user = await User.findById(payload.userId);
  if (!user) {
    send(ctx.ws, { type: 'authResult', ok: false, error: 'User not found' });
    ctx.ws.close();
    return;
  }
  ctx.userId = user._id;
  ctx.username = user.username;
  ctx.authenticated = true;
  send(ctx.ws, {
    type: 'authResult',
    ok: true,
    user: { id: user._id.toString(), username: user.username, virtualBalance: user.virtualBalance },
  });
}

async function handleSubscribe(ctx: ClientCtx, symbols: string[], reqId?: string): Promise<void> {
  // Normalised list of every symbol the client is asking for, whether or not
  // it was already in `ctx.subscriptions`. We still need to push initial
  // quotes for already-subscribed symbols too — otherwise a freshly-mounted
  // page that re-subscribes the same set never sees an LTP until the next
  // price-loop tick (1–3 s away under rate-limit conditions). This was the
  // root cause of "P&L stays at — after I just bought a position".
  const requested: string[] = [];
  for (const s of symbols) {
    const u = s.toUpperCase().trim();
    if (!u) continue;
    if (!requested.includes(u)) requested.push(u);
    ctx.subscriptions.add(u);
  }
  send(ctx.ws, {
    type: 'subscribed',
    reqId,
    symbols: Array.from(ctx.subscriptions),
  });
  if (requested.length === 0) return;

  // 1) Synchronous cached push — sub-ms, gives the FE a number immediately.
  const cachedQuotes: Quote[] = [];
  for (const sym of requested) {
    const ys = toYahooSymbol(sym);
    const q = getLatestCached(ys);
    if (q) cachedQuotes.push(q);
  }
  if (cachedQuotes.length) {
    send(ctx.ws, { type: 'priceUpdate', quotes: cachedQuotes });
  }
  // 2) Asynchronous fresh fetch — covers symbols not in cache (typical for
  //    freshly-bought option contracts, which Angel's display-symbol
  //    resolver doesn't index and require the option-token fallback path).
  try {
    const fresh = await fetchQuotes(requested);
    if (fresh.length) send(ctx.ws, { type: 'priceUpdate', quotes: fresh });
  } catch (err: any) {
    console.error('[ws] subscribe initial fetch failed:', err.message);
  }
}

function handleUnsubscribe(ctx: ClientCtx, symbols: string[], reqId?: string): void {
  for (const s of symbols) ctx.subscriptions.delete(s.toUpperCase());
  send(ctx.ws, {
    type: 'unsubscribed',
    reqId,
    symbols: Array.from(ctx.subscriptions),
  });
}

async function handlePlaceOrder(
  ctx: ClientCtx,
  payload: {
    symbol: string;
    type: 'market' | 'limit' | 'sl' | 'sl-m';
    side: 'buy' | 'sell';
    quantity: number;
    price?: number;
    triggerPrice?: number;
    validity?: 'DAY' | 'IOC' | 'GTT';
    product?: 'CNC' | 'MIS' | 'NRML';
    planId?: string;
    bracketStopLoss?: number;
    bracketTarget?: number;
  },
  reqId?: string
): Promise<void> {
  try {
    // ── Input validation (defense in depth — never trust the socket payload) ──
    if (typeof payload.symbol !== 'string' || payload.symbol.length > 40)
      return sendError(ctx.ws, reqId, 'Invalid symbol');
    const symbol = payload.symbol.toUpperCase().trim();
    if (!symbol) return sendError(ctx.ws, reqId, 'Symbol required');
    if (!['market', 'limit', 'sl', 'sl-m'].includes(payload.type))
      return sendError(ctx.ws, reqId, 'Invalid order type');
    if (!['buy', 'sell'].includes(payload.side))
      return sendError(ctx.ws, reqId, 'Invalid side');
    if (payload.product && !['CNC', 'MIS', 'NRML'].includes(payload.product))
      return sendError(ctx.ws, reqId, 'Invalid product');
    if (!Number.isInteger(payload.quantity) || payload.quantity <= 0 || payload.quantity > 10_000_000)
      return sendError(ctx.ws, reqId, 'Quantity must be a positive whole number');
    const finitePos = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0;
    // limit + SL-limit need a limit price; SL + SL-M need a trigger price.
    if ((payload.type === 'limit' || payload.type === 'sl') && !finitePos(payload.price))
      return sendError(ctx.ws, reqId, 'Limit price required');
    if ((payload.type === 'sl' || payload.type === 'sl-m') && !finitePos(payload.triggerPrice))
      return sendError(ctx.ws, reqId, 'Trigger price required for stop-loss orders');
    if (payload.bracketStopLoss != null && !finitePos(payload.bracketStopLoss))
      return sendError(ctx.ws, reqId, 'Invalid bracket stop-loss');
    if (payload.bracketTarget != null && !finitePos(payload.bracketTarget))
      return sendError(ctx.ws, reqId, 'Invalid bracket target');

    // NSE / MCX rule: indices and commodity friendly names have NO cash
    // market — they're tradable only via F&O. Reject direct buy/sell on
    // the underlying so a misbehaving client can't slip a phantom trade
    // past the UI guard.
    if (DERIVATIVES_ONLY.has(symbol)) {
      return sendError(
        ctx.ws,
        reqId,
        `${symbol} is index/commodity — trade via Options (CE/PE) or Futures.`,
      );
    }

    // Market-hours gate — no NEW orders outside the trading window (NSE/BSE
    // 9:15–15:30, MCX 9:00–23:30, weekdays). Pre-open (9:00–9:15) is NOT
    // tradable for equity/F&O. Resting SL/target already on the book fire at
    // the next open via the matcher, not here.
    if (!isSymbolTradingOpen(symbol)) {
      return sendError(ctx.ws, reqId, marketStatusForSymbol(symbol).reason);
    }

    // Enforce lot multiple BEFORE creating the order row, so a stray
    // single-share option order never even gets persisted.
    const lotSize = lookupLotSize(symbol);
    if (lotSize > 1 && payload.quantity % lotSize !== 0) {
      return sendError(
        ctx.ws,
        reqId,
        `Quantity must be a multiple of ${lotSize} for ${symbol}`,
      );
    }

    // Limit price applies to limit + SL-limit; trigger applies to SL + SL-M.
    const limitPrice = payload.type === 'limit' || payload.type === 'sl' ? payload.price : undefined;
    const triggerPrice = payload.type === 'sl' || payload.type === 'sl-m' ? payload.triggerPrice : undefined;
    const validity = payload.validity || 'DAY';
    const order = await Order.create({
      userId: ctx.userId,
      symbol,
      type: payload.type,
      side: payload.side,
      quantity: payload.quantity,
      price: limitPrice,
      triggerPrice,
      validity,
      product: payload.product || 'CNC',
      status: 'pending',
      planId: payload.planId ? new Types.ObjectId(payload.planId) : undefined,
      bracketStopLoss: payload.bracketStopLoss && payload.bracketStopLoss > 0 ? payload.bracketStopLoss : undefined,
      bracketTarget: payload.bracketTarget && payload.bracketTarget > 0 ? payload.bracketTarget : undefined,
    });

    if (payload.type === 'market') {
      // Resolve the live price. `resolveQuote` handles option contracts via
      // scripMaster, so even contracts the user hasn't subscribed to before
      // (typical first-trade-after-opening-the-chain flow) get a quote.
      const priceQuote = await resolveQuote(symbol);
      if (!priceQuote || !priceQuote.price) {
        order.status = 'rejected';
        order.rejectReason = 'No live quote available';
        await order.save();
        return sendError(ctx.ws, reqId, 'No live quote available for symbol');
      }
      try {
        // Walk the real order book (spread + actual available volume) — a
        // market order never fills at the clean single LTP.
        const fillPx = await marketFillPrice(symbol, payload.side, payload.quantity, priceQuote.price);
        const fill = await executeFill(order, fillPx);
        send(ctx.ws, {
          type: 'orderResult',
          reqId,
          ok: true,
          order: serializeOrder(fill.order),
        });
        send(ctx.ws, {
          type: 'orderFilled',
          order: serializeOrder(fill.order),
          fillPrice: fill.fillPrice,
          newBalance: fill.newBalance,
          position: fill.positionSnapshot,
        });
        // Auto-subscribe to the filled symbol so the user sees live updates
        ctx.subscriptions.add(symbol);
        // Push the fill price as an immediate priceUpdate so the Positions
        // tab can render real numbers RIGHT NOW (instead of "—" for the 1–3 s
        // wait until the next price-loop tick finishes its rate-limit dance).
        // priceQuote already carries the full Quote shape — just forward it.
        send(ctx.ws, { type: 'priceUpdate', quotes: [priceQuote] });
        await broadcastPortfolio(ctx);
      } catch (err: any) {
        send(ctx.ws, { type: 'orderResult', reqId, ok: false, error: err.message });
      }
    } else {
      // limit / sl / sl-m: rest as pending. The global matcher fills them
      // server-side (even if this client disconnects). Subscribe so the user
      // sees the live price driving toward their trigger/limit.
      ctx.subscriptions.add(symbol);
      send(ctx.ws, {
        type: 'orderResult',
        reqId,
        ok: true,
        order: serializeOrder(order),
      });
    }
  } catch (err: any) {
    console.error('[ws] placeOrder error:', err);
    sendError(ctx.ws, reqId, err.message || 'Order error');
  }
}

/**
 * Exit one position (or all) at market — over the open socket, so it's
 * millisecond-fast (no HTTP handshake; fills are priced from the live cache,
 * never an upstream call). Streams an `orderFilled` per close and replies with
 * the per-symbol results keyed by reqId.
 */
async function handleExit(
  ctx: ClientCtx,
  opts: { symbol?: string; product?: 'CNC' | 'MIS' | 'NRML' },
  reqId?: string,
): Promise<void> {
  try {
    const { results, fills } = await closePositions(ctx.userId, opts);
    for (const fill of fills) {
      send(ctx.ws, {
        type: 'orderFilled',
        order: serializeOrder(fill.order),
        fillPrice: fill.fillPrice,
        newBalance: fill.newBalance,
        position: fill.positionSnapshot,
      });
    }
    send(ctx.ws, { type: 'exitResult', reqId, ok: true, results });
    await broadcastPortfolio(ctx);
  } catch (err: any) {
    send(ctx.ws, { type: 'exitResult', reqId, ok: false, error: err.message || 'Exit failed', results: [] });
  }
}

async function handleCancelOrder(ctx: ClientCtx, orderId: string, reqId?: string): Promise<void> {
  try {
    const order = await Order.findOne({ _id: orderId, userId: ctx.userId });
    if (!order) return sendError(ctx.ws, reqId, 'Order not found');
    if (order.status !== 'pending')
      return sendError(ctx.ws, reqId, `Cannot cancel ${order.status} order`);
    order.status = 'cancelled';
    await order.save();
    send(ctx.ws, { type: 'orderResult', reqId, ok: true, order: serializeOrder(order) });
    send(ctx.ws, { type: 'orderCancelled', order: serializeOrder(order) });
  } catch (err: any) {
    sendError(ctx.ws, reqId, err.message || 'Cancel error');
  }
}

/**
 * Modify a RESTING order's limit price, trigger price, and/or quantity. Only
 * pending/partial non-market orders can be modified; the next matcher tick
 * picks up the new terms. Quantity can't drop below what's already filled and
 * must stay lot-aligned.
 */
async function handleModifyOrder(
  ctx: ClientCtx,
  msg: { orderId: string; price?: number; triggerPrice?: number; quantity?: number },
  reqId?: string,
): Promise<void> {
  try {
    const order = await Order.findOne({ _id: msg.orderId, userId: ctx.userId });
    if (!order) return sendError(ctx.ws, reqId, 'Order not found');
    if (order.status !== 'pending' && order.status !== 'partial')
      return sendError(ctx.ws, reqId, `Cannot modify a ${order.status} order`);
    if (order.type === 'market')
      return sendError(ctx.ws, reqId, 'Market orders fill instantly — nothing to modify');

    if (msg.quantity != null) {
      const q = Math.floor(msg.quantity);
      if (q <= 0) return sendError(ctx.ws, reqId, 'Quantity must be greater than 0');
      const lot = lookupLotSize(order.symbol);
      if (lot > 1 && q % lot !== 0)
        return sendError(ctx.ws, reqId, `Quantity must be a multiple of ${lot} for ${order.symbol}`);
      if (q < (order.filledQuantity || 0))
        return sendError(ctx.ws, reqId, `Quantity can't be below the already-filled ${order.filledQuantity}`);
      order.quantity = q;
    }
    if (msg.price != null && (order.type === 'limit' || order.type === 'sl')) {
      if (msg.price <= 0) return sendError(ctx.ws, reqId, 'Limit price must be greater than 0');
      order.price = msg.price;
    }
    if (msg.triggerPrice != null && (order.type === 'sl' || order.type === 'sl-m')) {
      if (msg.triggerPrice <= 0) return sendError(ctx.ws, reqId, 'Trigger price must be greater than 0');
      order.triggerPrice = msg.triggerPrice;
    }

    await order.save();
    send(ctx.ws, { type: 'orderResult', reqId, ok: true, order: serializeOrder(order) });
    send(ctx.ws, { type: 'orderModified', order: serializeOrder(order) });
  } catch (err: any) {
    sendError(ctx.ws, reqId, err.message || 'Modify error');
  }
}

// Symbols that must always remain on every user's watchlist.
const LOCKED_WATCHLIST_SYMBOLS = ['NIFTY', 'SENSEX', 'BANKNIFTY', 'GOLD', 'SILVER', 'CRUDEOIL'];

async function handleUpdateWatchlist(
  ctx: ClientCtx,
  symbols: string[],
  reqId?: string
): Promise<void> {
  try {
    const cleaned = Array.from(new Set(symbols.map((s) => s.toUpperCase().trim()).filter(Boolean)));
    // Re-inject locked symbols if the client tried to drop any of them.
    for (const s of LOCKED_WATCHLIST_SYMBOLS) {
      if (!cleaned.includes(s)) cleaned.unshift(s);
    }
    const wl = await Watchlist.findOneAndUpdate(
      { userId: ctx.userId },
      { symbols: cleaned },
      { upsert: true, new: true }
    );
    cleaned.forEach((s) => ctx.subscriptions.add(s));
    send(ctx.ws, {
      type: 'watchlistUpdated',
      reqId,
      ok: true,
      symbols: wl.symbols,
    });
  } catch (err: any) {
    sendError(ctx.ws, reqId, err.message || 'Watchlist error');
  }
}

export function serializeOrder(o: any) {
  return {
    id: o._id.toString(),
    symbol: o.symbol,
    type: o.type,
    side: o.side,
    quantity: o.quantity,
    price: o.price,
    triggerPrice: o.triggerPrice,
    validity: o.validity,
    filledQuantity: o.filledQuantity,
    avgFillPrice: o.avgFillPrice,
    filledPrice: o.filledPrice,
    status: o.status,
    product: o.product,
    planId: o.planId?.toString(),
    rejectReason: o.rejectReason,
    createdAt: o.createdAt,
    filledAt: o.filledAt,
  };
}

export async function broadcastPortfolio(ctx: ClientCtx): Promise<void> {
  // 300 ms cache per user. At a 500 ms tick interval with N WS clients per
  // user (mobile + desktop), this collapses redundant Mongo+market_data
  // calls into one compute every other tick. The TTL is short enough that
  // the user never sees stale numbers — the very next tick refreshes.
  const cacheKey = `pf:${ctx.userId}`;
  let summary = await cacheGet<any>(cacheKey);
  if (!summary) {
    const positions = await Position.find({ userId: ctx.userId });
    const symbols = positions.filter((p) => p.netQuantity !== 0).map((p) => p.symbol);
    let quotes: Quote[] = [];
    if (symbols.length) {
      quotes = await fetchQuotes(symbols);
    }
    const map = new Map(quotes.map((q) => [q.displaySymbol.toUpperCase(), q]));
    summary = await computePortfolio(ctx.userId, map);
    await cacheSet(cacheKey, summary, 300);
  }
  send(ctx.ws, { type: 'portfolioUpdate', portfolio: summary });
}

export function rawSend(ws: WebSocket, payload: unknown): void {
  send(ws, payload);
}
