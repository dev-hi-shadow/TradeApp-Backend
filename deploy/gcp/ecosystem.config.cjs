/**
 * pm2 process config for the Tradar backend.
 *
 * IMPORTANT: instances=1 / fork mode (NEVER cluster). The backend holds live
 * state in memory — the WebSocket clients, the price-tick loop, the square-off
 * cron and the depth cache — so it must run as a single process. Clustering
 * would duplicate the loops and split the WS clients across workers.
 *
 * dotenv (in src/config/env.ts) loads ./.env relative to cwd, so cwd is pinned
 * to the repo root where your production .env lives.
 */
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'tradar-backend',
      cwd: path.resolve(__dirname, '../..'), // repo root (where .env + dist/ live)
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      // Cap V8 heap and recycle if RSS climbs — keeps the 1 GB VM healthy.
      node_args: '--max-old-space-size=512',
      max_memory_restart: '750M',
      env: {
        NODE_ENV: 'production',
      },
      // Logs: pm2 logs tradar-backend   (or ~/.pm2/logs/)
      merge_logs: true,
      time: true,
    },
  ],
};
