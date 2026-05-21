import WebSocket from 'ws';
import { Types } from 'mongoose';
import { ClientCtx, subscriptionManager } from './subscriptionManager';
import { verifyToken } from '../utils/jwt';
import { User } from '../models/User';
import { Order } from '../models/Order';
import { Position } from '../models/Position';
import { Watchlist } from '../models/Watchlist';
import { executeFill, computePortfolio, lookupLotSize } from '../services/orderEngine';
import { fetchQuotes, getLatestCached, toYahooSymbol, Quote } from '../services/marketData';
import { angel } from '../services/angelOne';
import { scripMaster } from '../services/scripMaster';

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
  | { type: 'placeOrder'; reqId?: string; order: { symbol: string; type: 'market' | 'limit'; side: 'buy' | 'sell'; quantity: number; price?: number; product?: 'CNC' | 'MIS' | 'NRML'; planId?: string } }
  | { type: 'cancelOrder'; reqId?: string; orderId: string }
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
  const added: string[] = [];
  for (const s of symbols) {
    const u = s.toUpperCase().trim();
    if (!u) continue;
    if (!ctx.subscriptions.has(u)) {
      ctx.subscriptions.add(u);
      added.push(u);
    }
  }
  send(ctx.ws, {
    type: 'subscribed',
    reqId,
    symbols: Array.from(ctx.subscriptions),
  });
  // Immediately push the latest cached quote (if available), then fetch fresh.
  if (added.length > 0) {
    const cachedQuotes: Quote[] = [];
    for (const sym of added) {
      const ys = toYahooSymbol(sym);
      const q = getLatestCached(ys);
      if (q) cachedQuotes.push(q);
    }
    if (cachedQuotes.length) {
      send(ctx.ws, { type: 'priceUpdate', quotes: cachedQuotes });
    }
    try {
      const fresh = await fetchQuotes(added);
      if (fresh.length) send(ctx.ws, { type: 'priceUpdate', quotes: fresh });
    } catch (err: any) {
      console.error('[ws] subscribe initial fetch failed:', err.message);
    }
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
    type: 'market' | 'limit';
    side: 'buy' | 'sell';
    quantity: number;
    price?: number;
    product?: 'CNC' | 'MIS' | 'NRML';
    planId?: string;
  },
  reqId?: string
): Promise<void> {
  try {
    const symbol = payload.symbol.toUpperCase().trim();
    if (!symbol) return sendError(ctx.ws, reqId, 'Symbol required');
    if (!payload.quantity || payload.quantity <= 0)
      return sendError(ctx.ws, reqId, 'Quantity must be > 0');
    if (payload.type === 'limit' && (!payload.price || payload.price <= 0))
      return sendError(ctx.ws, reqId, 'Limit price required');

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

    const order = await Order.create({
      userId: ctx.userId,
      symbol,
      type: payload.type,
      side: payload.side,
      quantity: payload.quantity,
      price: payload.type === 'limit' ? payload.price : undefined,
      product: payload.product || 'CNC',
      status: 'pending',
      planId: payload.planId ? new Types.ObjectId(payload.planId) : undefined,
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
        const fill = await executeFill(order, priceQuote.price);
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
        await broadcastPortfolio(ctx);
      } catch (err: any) {
        send(ctx.ws, { type: 'orderResult', reqId, ok: false, error: err.message });
      }
    } else {
      // Limit: keep pending, ensure subscription so engine can match
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
  const positions = await Position.find({ userId: ctx.userId });
  const symbols = positions.filter((p) => p.netQuantity !== 0).map((p) => p.symbol);
  let quotes: Quote[] = [];
  if (symbols.length) {
    quotes = await fetchQuotes(symbols);
  }
  const map = new Map(quotes.map((q) => [q.displaySymbol.toUpperCase(), q]));
  const summary = await computePortfolio(ctx.userId, map);
  send(ctx.ws, { type: 'portfolioUpdate', portfolio: summary });
}

export function rawSend(ws: WebSocket, payload: unknown): void {
  send(ws, payload);
}
