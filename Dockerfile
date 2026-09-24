# ─── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ─── Stage 2: Dev Mode (ts-node-dev hot reload for development) ────────────────
FROM node:20-slim AS dev
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @decibeltrade/cli

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY dashboard ./dashboard
COPY scripts ./scripts

RUN mkdir -p logs data

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -fs http://localhost:5000/health || exit 1

EXPOSE 5000

CMD ["npm", "run", "dev"]

# ─── Stage 3: Production Mode ──────────────────────────────────────────────────
FROM node:20-slim AS production
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pm2 @decibeltrade/cli

COPY package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY ecosystem.config.js ./
COPY dashboard ./dashboard

RUN mkdir -p logs data

HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -fs http://localhost:5000/health || exit 1

EXPOSE 5000

CMD ["pm2-runtime", "ecosystem.config.js"]
