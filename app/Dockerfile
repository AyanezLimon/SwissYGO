# SwissYGO dev — single self-contained image: Fastify serves the API (/api) AND
# the built Vue SPA (static + history fallback). Build context is app/.
# Multi-stage so the native better-sqlite3 build toolchain stays out of runtime.

# 1) Build the SPA -----------------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build            # → /web/dist

# 2) Install backend deps (compiles better-sqlite3) --------------------------
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY server/package*.json ./
RUN npm ci --omit=dev

# 3) Runtime -----------------------------------------------------------------
FROM node:22-alpine AS runtime
RUN apk add --no-cache libstdc++   # better-sqlite3 runtime dep
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DB_PATH=/data/swissygo.sqlite \
    PUBLIC_DIR=/app/public
COPY server/ ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=web /web/dist ./public
EXPOSE 8787
CMD ["node", "src/server.js"]
