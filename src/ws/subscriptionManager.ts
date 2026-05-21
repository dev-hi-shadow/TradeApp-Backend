import WebSocket from 'ws';
import { Types } from 'mongoose';

export interface ClientCtx {
  ws: WebSocket;
  userId: Types.ObjectId;
  username: string;
  subscriptions: Set<string>; // display symbols, uppercase
  authenticated: boolean;
  connectedAt: number;
}

class SubscriptionManager {
  private clients = new Map<WebSocket, ClientCtx>();

  register(ws: WebSocket): ClientCtx {
    const ctx: ClientCtx = {
      ws,
      userId: null as any,
      username: '',
      subscriptions: new Set(),
      authenticated: false,
      connectedAt: Date.now(),
    };
    this.clients.set(ws, ctx);
    return ctx;
  }

  remove(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  get(ws: WebSocket): ClientCtx | undefined {
    return this.clients.get(ws);
  }

  /** All symbols currently subscribed by any authenticated client. */
  allSubscribedSymbols(): string[] {
    const all = new Set<string>();
    for (const ctx of this.clients.values()) {
      if (!ctx.authenticated) continue;
      ctx.subscriptions.forEach((s) => all.add(s));
    }
    return Array.from(all);
  }

  /** Authenticated clients. */
  authenticatedClients(): ClientCtx[] {
    return Array.from(this.clients.values()).filter((c) => c.authenticated);
  }

  clientsForSymbol(symbol: string): ClientCtx[] {
    const upper = symbol.toUpperCase();
    return this.authenticatedClients().filter((c) => c.subscriptions.has(upper));
  }
}

export const subscriptionManager = new SubscriptionManager();
