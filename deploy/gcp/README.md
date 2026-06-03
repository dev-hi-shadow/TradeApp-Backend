# Deploy Tradar backend to Google Cloud (free, always-on, no cold start)

**Architecture:** a Compute Engine **`e2-micro` "Always Free" VM** running your
backend in **Docker**, behind **Caddy** (automatic HTTPS + WebSocket), with
**MongoDB Atlas M0** (free) as the database.

```
Browser ──HTTPS/WSS──▶ Caddy (:443, auto-TLS) ──▶ backend container (:4000) ──▶ MongoDB Atlas
                         (GCP e2-micro Always-Free VM, runs 24/7)
```

Two deploy styles are included — pick one:
- **Docker** (recommended, what this guide uses): `deploy/gcp/docker/`
- **Native pm2** (no Docker): `deploy/gcp/{setup-vm.sh,ecosystem.config.cjs,deploy.sh,Caddyfile}`

---

## Part A — Database: MongoDB Atlas M0 (free forever)

1. Sign up at <https://www.mongodb.com/cloud/atlas> → **Create** a free **M0** cluster
   (choose the **Google Cloud** provider + a nearby region).
2. **Database Access** → Add a user (username + password). Save them.
3. **Network Access** → Add IP. Easiest: allow `0.0.0.0/0` (the user/password still
   protects it). To lock down, add only your VM's external IP later.
4. **Connect → Drivers** → copy the connection string. It looks like:
   ```
   mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
   Insert the DB name `paper_trading` before the `?`:
   ```
   mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/paper_trading?retryWrites=true&w=majority
   ```
   (URL-encode any special characters in the password.) This is your `MONGO_URI`.

> Prefer self-hosting Mongo on the VM instead? See `deploy/mongo/docker-compose.yml`
> — but Atlas is recommended; it keeps the tiny VM's RAM free for the app.

---

## Part B — Create the VM (Always Free)

Install the `gcloud` CLI (<https://cloud.google.com/sdk/docs/install>) and log in
(`gcloud init`), then:

```bash
# Always-Free eligible: e2-micro in us-west1 / us-central1 / us-east1.
gcloud compute instances create tradar-backend \
  --zone=us-central1-a \
  --machine-type=e2-micro \
  --image-family=ubuntu-2204-lts \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=30GB \
  --tags=http-server,https-server
```

Open the firewall for web traffic (one-time):

```bash
gcloud compute firewall-rules create allow-http  --allow=tcp:80  --target-tags=http-server  --direction=INGRESS
gcloud compute firewall-rules create allow-https --allow=tcp:443 --target-tags=https-server --direction=INGRESS
```

Get the external IP (you'll use it for the domain):

```bash
gcloud compute instances describe tradar-backend --zone=us-central1-a \
  --format='get(networkInterfaces[0].accessConfigs[0].natIP)'
```

> No CLI? You can do all of the above in the Console: **Compute Engine → Create
> instance** (e2-micro, Ubuntu 22.04, check "Allow HTTP/HTTPS traffic").

SSH in:

```bash
gcloud compute ssh tradar-backend --zone=us-central1-a
```

---

## Part C — On the VM: install Docker

```bash
sudo apt-get update -y
sudo apt-get install -y git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker          # apply the group now (or log out/in)

# Recommended on a 1 GB VM: add 2 GB swap so builds don't OOM.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile \
  && sudo mkswap /swapfile && sudo swapon /swapfile \
  && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## Part D — Deploy

```bash
# 1) Clone your backend repo (use a token/deploy key if it's private)
git clone https://github.com/dev-hi-shadow/TradeApp-Backend.git
cd TradeApp-Backend

# 2) Create the production env
cp .env.production.example .env
nano .env
#    - MONGO_URI               → your Atlas string from Part A
#    - JWT_SECRET              → openssl rand -hex 48
#    - CORS_ORIGIN / APP_URL   → your frontend URL
#    - ANGEL_* , GOOGLE_SIGNIN_CLIENT_ID , etc.

# 3) Set your domain in the Caddyfile (sslip.io = no domain to buy)
nano deploy/gcp/docker/Caddyfile
#    replace  YOUR_VM_IP.sslip.io   with e.g.   34-123-45-67.sslip.io
#    (use your VM's external IP, dashes or dots both work)

# 4) Build + start (always-on)
cd deploy/gcp/docker
docker compose up -d --build

# 5) Watch it boot
docker compose logs -f backend
```

Verify:

```bash
curl -s https://34-123-45-67.sslip.io/health   # → {"ok":true,...}
```

That's it — the container restarts on crash and on VM reboot
(`restart: unless-stopped`), so it's truly always-on with zero cold start.

---

## Part E — Point the frontend at it

Wherever the frontend is hosted, set:

```
VITE_API_URL=https://34-123-45-67.sslip.io
VITE_WS_URL=wss://34-123-45-67.sslip.io/ws
```

and add the frontend's URL to the backend `.env` `CORS_ORIGIN`. Also add the
frontend origin to your **Google OAuth** "Authorized JavaScript origins".

---

## Day-2 operations

```bash
cd ~/TradeApp-Backend/deploy/gcp/docker

# Deploy new code
git -C ~/TradeApp-Backend pull
docker compose up -d --build

docker compose logs -f backend     # logs
docker compose restart backend     # restart app only
docker compose restart caddy       # reload after editing Caddyfile
docker compose down                # stop everything
docker stats                       # live RAM/CPU (watch memory on e2-micro)
```

### Troubleshooting
- **Cert not issued / HTTPS fails:** the domain must resolve to the VM and ports
  80+443 must be open (GCP firewall *and* reachable). sslip.io resolves
  automatically; just ensure the IP in the Caddyfile matches the VM.
- **Backend keeps restarting:** `docker compose logs backend` — usually a bad
  `MONGO_URI` or Atlas Network Access not allowing the VM IP.
- **Out of memory:** make sure swap is on (`free -h`); Atlas (not self-hosted
  Mongo) keeps RAM free; the app heap is already capped at 512 MB.
