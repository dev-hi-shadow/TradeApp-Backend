#!/usr/bin/env bash
#
# Pull latest, install, build, and (re)start the backend under pm2.
# Run from anywhere — it cd's to the repo root itself.
#
#   bash deploy/gcp/deploy.sh
#
set -euo pipefail

# Resolve repo root (two levels up from this script).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
echo "==> Repo: $ROOT"

if [ ! -f .env ]; then
  echo "✗ No .env found in $ROOT — copy .env.production.example to .env and fill it first."
  exit 1
fi

echo "==> Pulling latest"
git pull --ff-only

echo "==> Installing dependencies (incl. dev — needed for the TypeScript build)"
npm ci --include=dev

echo "==> Building (tsc → dist/)"
npm run build

echo "==> Starting / reloading under pm2"
pm2 startOrReload deploy/gcp/ecosystem.config.cjs --update-env
pm2 save

echo
echo "✅ Deployed. Health check:"
PORT="$(grep -E '^PORT=' .env | cut -d= -f2- || true)"; PORT="${PORT:-4000}"
sleep 1
curl -fsS "http://127.0.0.1:${PORT}/health" && echo "  ← backend OK" || echo "  ✗ /health not responding yet — check: pm2 logs tradar-backend"
