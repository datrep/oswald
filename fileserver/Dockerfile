# Oswald Fileserver — ARCH: separate, containerized service (task 49).
# Best practices: pinned LTS base, deps-first layer caching, non-root user,
# healthcheck. Runtime config (roots, mode, DB, TLS) comes from the environment
# via fileserver/config.js — no Windows paths baked in.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install dependencies first (layer cache: reinstalls only when deps change).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# App code.
COPY . .

# Non-root user (`node` ships with node:alpine). Create writable runtime dirs.
RUN mkdir -p /app/temp-uploads && chown -R node:node /app

USER node

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8091/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
