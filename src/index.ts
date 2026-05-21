import express from 'express';
import http from 'http';
import cors from 'cors';
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
import { angel } from './services/angelOne';
import { angelEnabled } from './config/env';
import { scripMaster } from './services/scripMaster';
import { startSquareOffCron } from './services/squareOff';

async function main() {
  await connectDB();

  const app = express();
  app.use(
    cors({
      origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
    })
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

  app.use('/api/auth', authRoutes);
  app.use('/api/market', marketRoutes);
  app.use('/api/plans', plansRoutes);
  app.use('/api', ordersRoutes); // /api/orders, /api/positions, /api/transactions
  app.use('/api/account', accountRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/alerts', alertsRoutes);

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
  } else {
    console.warn('[server] Angel One disabled — falling back to yahoo-finance only');
  }
}

main().catch((err) => {
  console.error('[server] fatal:', err);
  process.exit(1);
});
