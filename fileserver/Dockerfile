# Oswald Fileserver — ARCH: separate, containerized service (task 49).
# Build context is the repo ROOT (compose.yaml: build.context = ".") because the
# fileserver requires ../shared, ../utils, ../models, and ../config.
# Runtime config (roots, mode, DB, TLS) comes from the environment via
# fileserver/config.js — no Windows paths baked in.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install fileserver deps first (layer cache: reinstalls only when deps change).
COPY fileserver/package.json fileserver/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# App code: the fileserver service + the repo modules it requires.
COPY fileserver/ ./fileserver/
COPY shared/ ./shared/
COPY utils/ ./utils/
COPY models/ ./models/
COPY config/ ./config/

# Non-root user (`node` ships with node:alpine). Ensure writable runtime dirs.
RUN mkdir -p /app/fileserver/temp-uploads && chown -R node:node /app

USER node

EXPOSE 8090 8091

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8091/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "fileserver/server.js"]
