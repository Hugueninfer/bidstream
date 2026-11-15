# BidStream

[![CI](https://github.com/hugueninfer/bidstream/actions/workflows/ci.yml/badge.svg)](https://github.com/hugueninfer/bidstream/actions/workflows/ci.yml)

An event-driven procurement platform: buyers publish requests for quote (RFQs),
suppliers bid in real time, a pricing model predicts what a fair price looks
like, and the buyer awards the best bid.

The business logic is intentionally small. The point of the project is the
platform underneath it — service boundaries, an event bus with delivery
guarantees, polyglot services speaking gRPC, graceful degradation, and
observability — built the way it would be run in production.

## Architecture

```
                         ┌───────────────────────── Kafka (Redpanda) ─────────────────────────┐
                         │        rfq.events  ·  bid.events  ·  *.dlq                         │
                         └──▲──────────────┬──────────────▲──────────────┬──────────────┬─────┘
                    outbox  │              │      outbox  │              │              │
browser ──REST/SSE──▶ edge-gateway ──gRPC──▶ rfq-service  │  bid-service ◀┘    pricing-service
  (React)             (TypeScript)  │      (Python)  ───gRPC GetBid──▶ (TypeScript)   (Python)
                         ▲          ├──gRPC──────────────────────────────▶ │            │
                         │          └──gRPC───────────────────────────────────────────▶ │
                         └── activity feed                Postgres ×3 (one DB per service) + Redis
```

| Service | Language | Responsibility |
|---|---|---|
| `edge-gateway` | TypeScript (Fastify) | Public REST API `/v1` + OpenAPI, SSE activity stream, timeouts, error envelope, latency/health aggregation |
| `rfq-service` | Python (grpc.aio) | RFQs and awards; projects bid counts / best bid from `bid.events` |
| `bid-service` | TypeScript (grpc-js) | Supplier bids with idempotency keys; validates against an RFQ read model built from `rfq.events` |
| `pricing-service` | Python (grpc.aio) | Price prediction (log-log regression over ~6.5k historical awards), Redis cache with event-driven invalidation |
| `web` | React + Vite + Tailwind | Buyer and supplier UI with a live view of the event stream |

### Platform patterns on display

- **Transactional outbox** — state change and event are written in one DB
  transaction, then relayed to Kafka. No dual writes. ([ADR 0001](docs/adr/0001-transactional-outbox.md))
- **Idempotent consumers + dead-letter queues** — at-least-once delivery with
  effectively-once side effects; poison messages go to `<topic>.dlq` instead of
  blocking a partition.
- **Idempotent API** — `Idempotency-Key` on bid submission; replays return the
  original bid (`200`), concurrent duplicates create exactly one.
- **REST at the edge, gRPC inside** — versioned protos in [`proto/`](proto/),
  a BFF gateway owning edge concerns. ([ADR 0002](docs/adr/0002-rest-edge-grpc-inside.md))
- **Database per service + read models** — no shared tables; eventual
  consistency is surfaced honestly (`409 rfq_syncing`). ([ADR 0003](docs/adr/0003-database-per-service.md))
- **Graceful degradation** — kill `pricing-service` and the app keeps working:
  estimates become `null` with a reason, health turns red, bids and awards continue.
- **Cache invalidation by event** — an award bumps a per-SKU version counter in
  Redis, invalidating every cached quantity for that SKU in one `INCR`.
- **Distributed tracing** — OpenTelemetry across HTTP, gRPC *and* Kafka (the
  `traceparent` travels inside the outbox row and the message headers).
- **Multi-tenant by construction** — `tenant_id` on every row, RPC and event.

All contracts (APIs, events, tables, error codes) are in
[`docs/contracts.md`](docs/contracts.md).

## Run it

Requirements: Docker with Compose, `make`, `curl`, `jq`.

```bash
make up          # build images and start everything
make seed        # load the demo story
make e2e         # end-to-end test through the public API
```

| URL | What |
|---|---|
| http://localhost:3080 | Web app |
| http://localhost:8000/openapi.json | REST API (OpenAPI 3.1) |
| http://localhost:8088 | Redpanda Console — topics, messages, DLQs, consumer groups |
| http://localhost:16686 | Jaeger — traces across gateway, services and Kafka |

Try the failure modes:

```bash
docker compose stop pricing-service   # UI degrades, bids still flow
docker compose start pricing-service
```

## Tests

```bash
make test        # unit tests for all services and the web app
```

| Suite | Tests |
|---|---|
| rfq-service | 88 unit + 7 integration (Postgres: concurrent awards, consumer idempotency, migrations) |
| pricing-service | 50 unit + 3 integration (seeding, cache hit/miss, award → version bump) |
| bid-service | 55 unit + 18 integration (idempotency under 8 concurrent requests, read model, relay) |
| edge-gateway | 103 (mapping, error codes, p95 window, SSE backlog + live, fake gRPC servers) |
| web | 49 (price signals, formatting, SSE reducer, API errors) |
| `scripts/e2e.sh` | 12 end-to-end checks through the public API |

Integration tests run per service: `make -C services/<name> test-integration`.

## Repository layout

```
proto/            gRPC contracts (versioned)
services/         edge-gateway, rfq-service, bid-service, pricing-service
web/              React front end (mock mode: `npm run dev:mock`)
infra/            local bootstrap: databases, Kafka topics
docs/             contracts and architecture decision records
scripts/          e2e test and demo seed
```

## Roadmap

- [x] Services, event bus, front end, tests — running locally with Docker Compose
- [ ] CI (GitHub Actions): tests, multi-arch images to GHCR
- [ ] Kubernetes (Helm), service mesh (Istio ambient: mTLS, authz, canary)
- [ ] Load testing with k6 + SLOs and a before/after performance report
- [ ] Public deployment (k3s + Argo CD on a free-tier VM, front end on Vercel)
- [ ] MCP gateway for AI agents with tenant-scoped tools; AIOps triage agent with evals
- [ ] Terraform for AWS (EKS, MSK, ElastiCache)

## AI-assisted development

This project was built with the assistance of AI tools (Claude / Claude Code).
The workflow was contract-first: APIs, events and architecture decisions were
written down before any code, services were then implemented against those
contracts with AI assistance, and every piece was reviewed, integrated and
verified end to end with the test suites above. The rules the AI tooling
follows in this repo live in [`CLAUDE.md`](CLAUDE.md).
