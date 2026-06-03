/**
 * Rate limiters. The app is reachable over a public ngrok URL, so unauthenticated
 * and high-cost endpoints need a cap.
 *
 * trustProxy validation is disabled because we run behind ngrok + the Vite dev
 * proxy (so Express's view of the proxy chain isn't the standard 1-hop). We
 * accept that for this paper-trading app and key the strict auth limiter on the
 * submitted ACCOUNT too, so brute-force is throttled per-account regardless of
 * shared proxy IPs.
 */
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

/** Strict: login / register / forgot-password. ~30 attempts / 15 min per (ip, account). */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'Too many attempts — please wait a few minutes and try again.' },
  keyGenerator: (req: Request) => {
    const acct = String((req.body && (req.body.emailOrUsername || req.body.email)) || '').toLowerCase();
    // ipKeyGenerator normalises IPv6 to a /64 subnet so v6 clients can't bypass.
    return `${ipKeyGenerator(req.ip || '')}|${acct}`;
  },
});

/** General cap across all other /api routes (generous; REST is low-frequency — live data is WS). */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
  message: { error: 'Rate limit exceeded — slow down a moment.' },
});
