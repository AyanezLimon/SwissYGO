# SwissYGO backend image — API only (the static SPA is served by Caddy, not here).
# Build context is app/server. Built rarely: only when the backend changes, never
# for frontend edits. Multi-stage so the better-sqlite3 build toolchain (needed
# only if no ARM prebuilt is fetched) stays out of the runtime image.
FROM node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine AS runtime
RUN apk add --no-cache libstdc++
WORKDIR /app
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0 DB_PATH=/data/swissygo.sqlite
COPY --from=deps /app/node_modules ./node_modules
COPY . ./
EXPOSE 8787
CMD ["node", "src/server.js"]
