# syntax=docker/dockerfile:1
# Build context: repository root (the image copies proto/).
#   docker build -f services/edge-gateway/Dockerfile -t bidstream-edge-gateway:dev .

FROM node:22-alpine AS build
WORKDIR /app
COPY services/edge-gateway/package.json services/edge-gateway/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY services/edge-gateway/tsconfig.json services/edge-gateway/tsconfig.build.json ./
COPY services/edge-gateway/src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22-alpine
# A bigger libuv pool keeps slow DNS lookups for not-yet-existing upstreams
# (grpc-js re-resolves them constantly) from starving Kafka's connection lookups.
ENV NODE_ENV=production \
    HTTP_PORT=8080 \
    PROTO_DIR=/app/proto \
    UV_THREADPOOL_SIZE=16
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node proto ./proto
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${HTTP_PORT}/healthz" >/dev/null || exit 1
# Exec form so node is PID 1 and receives SIGTERM directly.
CMD ["node", "--enable-source-maps", "--import", "./dist/tracing.js", "dist/main.js"]
