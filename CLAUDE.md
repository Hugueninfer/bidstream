# BidStream — notes for Claude Code

Event-driven RFQ (request for quote) platform built as a platform-engineering
portfolio project. Read `docs/contracts.md` before changing any API, proto,
event or table: it is the source of truth for how services talk.

## Layout

- `proto/` — gRPC contracts (one package per service, `v1`).
- `services/rfq-service` (Python, gRPC), `services/pricing-service` (Python, gRPC),
  `services/bid-service` (TypeScript, gRPC), `services/edge-gateway` (TypeScript, REST + SSE).
- `web/` — React + Vite + Tailwind front end, talks only to edge-gateway `/v1`.
- `infra/` — local infra bootstrap (Postgres databases, Kafka topics).
- `docs/adr/` — architecture decision records.

## Rules

- REST at the edge, gRPC inside, events for everything that happened.
- A service owns its database. Never query another service's DB.
- Publish events only through the transactional outbox; consumers must be
  idempotent (`processed_events`) and send poison messages to `<topic>.dlq`.
- Every query filters by `tenant_id`.
- Docker build context is the repo root (images copy `proto/`).
- Keep each service runnable and testable on its own: `make test` inside the
  service directory.

## Commands

- `make up` — build images (host network, see Makefile) and start the whole stack; UI on http://localhost:3080,
  API on http://localhost:8000, Redpanda Console on :8088, Jaeger on :16686.
- `docker compose up -d postgres redis redpanda redpanda-init` — infra only
  (host ports: Postgres 55432, Redis 56379, Kafka 19092).
- `scripts/e2e.sh` — end-to-end smoke test against a running stack.
