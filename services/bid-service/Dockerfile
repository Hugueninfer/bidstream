# syntax=docker/dockerfile:1
# Build context: repository root (the image needs proto/).
#   docker build -f services/bid-service/Dockerfile -t bidstream-bid-service .

FROM node:22-alpine AS build
WORKDIR /app
COPY services/bid-service/package.json services/bid-service/package-lock.json services/bid-service/.npmrc ./
RUN npm ci
COPY services/bid-service/tsconfig.json services/bid-service/tsconfig.build.json ./
COPY services/bid-service/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    GRPC_PORT=50062 \
    PROTO_DIR=/app/proto \
    MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node services/bid-service/package.json ./
COPY --chown=node:node services/bid-service/migrations ./migrations
COPY --chown=node:node proto ./proto
USER node
EXPOSE 50062
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD ["node", "dist/healthcheck.js"]
# exec form: node is PID 1 and receives SIGTERM directly.
CMD ["node", "dist/main.js"]
