import express from 'express';
import http from 'http';
import cors from 'cors';
import helmet from 'helmet';
import { authLimiter, apiLimiter } from './middleware/rateLimit';
import { env } from './config/env';
import { connectDB } from './config/db';
import { attachWebSocketServer } from './ws/wsServer';

import authRoutes from './routes/auth';
import marketRoutes from './routes/market';
import plansRoutes from './routes/plans';
import ordersRoutes from './routes/orders';
import accountRoutes from './routes/account';
import adminRoutes from './routes/admin';
import alertsRoutes from './routes/alerts';
import pushRoutes from './routes/push';
import analyticsRoutes from './routes/analytics';
import watchlistsRoutes from './routes/watchlists';
import { angel } from './services/angelOne';
import { angelEnabled, angelFeedEnabled } from './config/env';
import { scripMaster } from './services/scripMaster';
import { startSquareOffCron } from './services/squareOff';
import { angelFeed } from './services/angelFeed';

async function main() {
  await connectDB();

  const app = express();
  // Behind ngrok + the Vite dev proxy — trust the forwarded client IP.
  app.set('trust proxy', true);
  // Security headers (safe defaults for a JSON API; CSP off since we serve no HTML).
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) =>
    res.json({
      ok: true,
      ts: Date.now(),
      // Single Angel live-feed health (only meaningful when ANGEL_FEED_WS is on).
      feed: angelFeedEnabled ? angelFeed.status() : { enabled: false },
    }),
  );

  // Generous global cap on everything under /api...
  app.use('/api', apiLimiter);
  // ...plus a strict brute-force cap on the password/credential endpoints only.
  // (Deliberately NOT on /config, /refresh, /verify-email, /sessions — those are
  // hit on every page load / token rotation and must not exhaust the auth budget.)
  app.use(
    ['/api/auth/login', '/api/auth/register', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/google'],
    authLimiter,
  );
  app.use('/api/auth', authRoutes);
  app.use('/api/market', marketRoutes);
  app.use('/api/plans', plansRoutes);
  app.use('/api', ordersRoutes); // /api/orders, /api/positions, /api/transactions
  app.use('/api/account', accountRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/alerts', alertsRoutes);
  app.use('/api/push', pushRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/watchlists', watchlistsRoutes);

  app.use((err: any, _req: any, res: any, _next: any) => {
    console.error('[express] error:', err);
    res.status(500).json({ error: err.message || 'Server error' });
  });

  const server = http.createServer(app);
  attachWebSocketServer(server);

  server.listen(env.PORT, () => {
    console.log(`[server] HTTP+WS listening on http://localhost:${env.PORT}`);
    console.log(`[server] WebSocket endpoint: ws://localhost:${env.PORT}/ws`);
  });

  // MIS auto-square-off cron (runs every 30s, fires at 15:20 / 15:25 / 23:25 IST).
  startSquareOffCron();

  // Warm up Angel One + scrip master in the background.
  // Failures here don't block the server — endpoints will retry on demand.
  if (angelEnabled) {
    angel.login().catch((err) =>
      console.error('[server] angel login warmup failed:', err.message || err)
    );
    scripMaster.ensure().catch((err) =>
      console.error('[server] scrip-master warmup failed:', err.message || err)
    );
    // Refresh scrip master daily
    setInterval(
      () => scripMaster.ensure().catch(() => {}),
      24 * 60 * 60 * 1000
    );
    // Open the single Angel SmartWebSocketV2 live feed (opt-in). It connects
    // lazily and the price loop drives its subscriptions; REST stays as the
    // automatic fallback whenever the socket isn't delivering.
    if (angelFeedEnabled) {
      console.log('[server] Angel SmartWebSocketV2 live feed ENABLED');
      angelFeed.ensureConnected();
    }
  } else {
    console.warn('[server] Angel One disabled — using market-data provider chain only');
  }
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
