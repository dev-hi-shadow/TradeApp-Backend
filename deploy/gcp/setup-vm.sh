#!/usr/bin/env bash
#
# One-time provisioning for a Google Cloud "Always Free" e2-micro Ubuntu VM.
# Installs: swap (vital on 1 GB RAM), Node 20, pm2, Caddy (auto-HTTPS), firewall.
#
# Usage (on the VM, after SSH):
#   bash deploy/gcp/setup-vm.sh
#
set -euo pipefail

echo "==> 1/6  Swap file (critical on a 1 GB VM — prevents OOM during builds)"
if ! sudo swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  echo "    2 GB swap enabled."
else
  echo "    swap already present, skipping."
fi

echo "==> 2/6  Base packages"
sudo apt-get update -y
sudo apt-get install -y curl git ufw ca-certificates gnupg

echo "==> 3/6  Node.js 20 (NodeSource)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "    node $(node -v), npm $(npm -v)"

echo "==> 4/6  pm2 (keeps the backend running 24/7 + restarts on boot/crash)"
sudo npm install -g pm2

echo "==> 5/6  Caddy (reverse proxy with automatic Let's Encrypt HTTPS + WebSocket)"
if ! command -v caddy >/dev/null 2>&1; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi
echo "    caddy $(caddy version | head -n1)"

echo "==> 6/6  Host firewall (ufw) — allow SSH + HTTP + HTTPS"
sudo ufw allow OpenSSH      >/dev/null 2>&1 || sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

echo
echo "✅ VM ready. Next steps:"
echo "   1) Put your production env in  ./.env   (copy from .env.production.example)"
echo "   2) Edit deploy/gcp/Caddyfile  → set your domain (e.g. <VM_IP>.sslip.io)"
echo "   3) sudo cp deploy/gcp/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy"
echo "   4) bash deploy/gcp/deploy.sh"
echo "   5) pm2 startup   (run the printed command)  &&  pm2 save"
