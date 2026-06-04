# ── Stage 1: build (TypeScript → dist/) ──────────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app

# Install ALL deps (incl. dev — needed for tsc), leveraging layer caching.
COPY package*.json ./
RUN npm ci --include=dev

# Compile.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production-only deps for a lean runtime image.
RUN npm prune --omit=dev

# ── Stage 2: runtime (small, prod-only) ──────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Cap V8 heap so the container behaves on the 1 GB Always-Free VM.
ENV NODE_OPTIONS=--max-old-space-size=512

# Run as the built-in non-root "node" user.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Writable cache dir (scrip-master instrument list, Angel token cache).
RUN mkdir -p /app/.cache && chown node:node /app/.cache

USER node
EXPOSE 4000

# Lightweight healthcheck hitting the existing /health route.
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
