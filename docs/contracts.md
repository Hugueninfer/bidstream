# BidStream contracts

Single source of truth for how the pieces talk to each other. If code and this
document disagree, fix one of them in the same change.

## Topology

```
browser ──REST /v1 + SSE──▶ edge-gateway (TS) ──gRPC──▶ rfq-service (Py)     ─┐
                                 │            ──gRPC──▶ bid-service (TS)      ├─ Postgres (one DB each)
                                 │            ──gRPC──▶ pricing-service (Py) ─┘   + Redis (pricing cache)
                                 └── consumes rfq.events + bid.events (activity feed)

rfq-service     ──outbox──▶ rfq.events ──▶ bid-service, pricing-service, edge-gateway
bid-service     ──outbox──▶ bid.events ──▶ rfq-service, edge-gateway
rfq-service     ──gRPC GetBid──▶ bid-service            (award validation)
```

Rule: **REST at the edge, gRPC inside, events for everything that happened.**
No service reads another service's database.

## Ports and addresses (inside docker compose / k8s)

| Service | Port | Protocol |
|---|---|---|
| edge-gateway | 8080 | HTTP (REST + SSE) |
| rfq-service | 50061 | gRPC |
| bid-service | 50062 | gRPC |
| pricing-service | 50063 | gRPC |
| postgres | 5432 | databases `rfq`, `bid`, `pricing`; user/password `bidstream` |
| redis | 6379 | |
| redpanda (Kafka API) | 9092 | |
| jaeger (OTLP HTTP) | 4318 | |

Every gRPC service also implements the standard `grpc.health.v1.Health` service.

## Environment variables

| Variable | Used by | Example |
|---|---|---|
| `GRPC_PORT` | rfq, bid, pricing | `50061` |
| `HTTP_PORT` | edge-gateway | `8080` |
| `DATABASE_URL` | rfq, bid, pricing | `postgresql://bidstream:bidstream@postgres:5432/rfq` |
| `KAFKA_BROKERS` | all | `redpanda:9092` |
| `REDIS_URL` | pricing | `redis://redis:6379/0` |
| `RFQ_SERVICE_ADDR` | gateway | `rfq-service:50061` |
| `BID_SERVICE_ADDR` | gateway, rfq | `bid-service:50062` |
| `PRICING_SERVICE_ADDR` | gateway | `pricing-service:50063` |
| `CORS_ORIGINS` | gateway | `http://localhost:5173,http://localhost:3080` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | all | `http://jaeger:4318` (unset = tracing off) |
| `OTEL_SERVICE_NAME` | all | `rfq-service` |
| `LOG_LEVEL` | all | `info` |

Services log JSON lines to stdout.

## gRPC

Protos live in `proto/bidstream/<service>/v1/*.proto` and are the contract:

- `rfq/v1/rfq.proto` — RfqService (rfq-service)
- `bid/v1/bid.proto` — BidService (bid-service)
- `pricing/v1/pricing.proto` — PricingService (pricing-service)

Python services generate stubs at image build time with `grpcio-tools`.
TypeScript services load protos at runtime with `@grpc/proto-loader`
(`keepCase: true`, `longs: Number`, `defaults: true`, `oneofs: true`).
Docker build context is the **repo root** so images can copy `proto/`.

Timestamps are RFC 3339 strings in UTC (`2026-11-16T17:00:00Z`). Money is a
`double` in USD on the wire and `NUMERIC(12,4)` in Postgres.

IDs: `rfq_` / `bid_` + 12 lowercase hex chars (`rfq_7f3a91c2b0de`).
Supplier IDs: `sup_` + slug of the supplier name (`sup_kestrel_fastening_co`).
Tenant: `tenant_demo` is the only tenant in the demo, but every row, event and
RPC carries `tenant_id` and every query filters on it.

## Events (Kafka)

Topics: `rfq.events`, `bid.events`, and dead-letter topics `rfq.events.dlq`,
`bid.events.dlq`. Message key = `rfq_id` (keeps one RFQ's events ordered).
Headers: `event_type`, and `traceparent` when a trace is active.

Envelope (JSON value):

```json
{
  "event_id": "8a1f5c6e-....",          // uuid v4, idempotency key for consumers
  "event_type": "bid.submitted",
  "version": 1,
  "occurred_at": "2026-11-14T14:02:11Z",
  "tenant_id": "tenant_demo",
  "key": "rfq_7f3a91c2b0de",
  "data": { ... }
}
```

| event_type | topic | data |
|---|---|---|
| `rfq.created` | rfq.events | `rfq_id, tenant_id, title, sku, quantity, unit, deadline, created_at` |
| `rfq.awarded` | rfq.events | `rfq_id, tenant_id, sku, quantity, bid_id, supplier_id, supplier_name, unit_price, awarded_at` |
| `bid.submitted` | bid.events | `bid_id, rfq_id, tenant_id, supplier_id, supplier_name, unit_price, currency, lead_time_days, submitted_at` |

### Producing: transactional outbox

A service never publishes to Kafka inside a request. It writes the business row
**and** an `outbox` row in the same DB transaction; a relay loop in the same
process publishes unpublished rows (`FOR UPDATE SKIP LOCKED`, batch of 100,
poll every ~200 ms) and marks them `published_at`. Delivery is at-least-once.

```sql
CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  event_id     UUID NOT NULL UNIQUE,
  topic        TEXT NOT NULL,
  key          TEXT NOT NULL,
  payload      JSONB NOT NULL,
  headers      JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
```

### Consuming: idempotent, with a DLQ

- Each consumer records handled events in
  `processed_events(event_id UUID, consumer TEXT, processed_at, PRIMARY KEY (event_id, consumer))`
  in the same transaction as its side effect; duplicates are skipped.
- Unknown `event_type`s are ignored (forward compatibility).
- On failure: retry 3 times with backoff (200 ms, 1 s, 3 s). Still failing →
  publish the original message to `<topic>.dlq` with extra headers
  `dlq_error`, `dlq_consumer`, then commit and move on.

| Consumer group | Topic(s) | Purpose |
|---|---|---|
| `bid-service` | rfq.events | keeps `rfq_view` (status, deadline, quantity) to validate bids |
| `rfq-service` | bid.events | keeps `bid_count`, best bid on each RFQ |
| `pricing-service` | rfq.events | appends awards to price history, invalidates cache |
| `edge-gateway-<uuid>` | rfq.events, bid.events | activity feed; reads from the beginning on start |

## Pricing model (pricing-service)

- Price history is deliberately **market-wide** (no `tenant_id`): every
  tenant's awards improve everyone's estimate. This is the one exception to the
  "every query filters by tenant_id" rule; no tenant-identifying data is stored.
- History table `price_observations(id, sku, quantity, unit_price, source, observed_at)`,
  seeded deterministically on first start (≈1,000–1,300 rows per SKU).
- Model v1, per SKU: least squares on `log(unit_price) = a + b·log(quantity)`.
  Estimate = `exp(a + b·log(q))`; band = estimate × `exp(p10)` … `exp(p90)` of
  the residuals (the "80% range" the UI talks about).
- Cache in Redis: key `price:{sku}:v{version}:{quantity}`, TTL 10 min, where
  `version` = `INCR`-ed counter `price:ver:{sku}`. An `rfq.awarded` event adds an
  observation and bumps the version, which invalidates every cached quantity
  for that SKU at once.

SKU catalog (anchor unit price at a typical quantity):

| SKU | Unit | Typical qty | Anchor price |
|---|---|---|---|
| BOLT-M8 | pcs | 40,000 | 0.47 |
| NUT-M8 | pcs | 60,000 | 0.13 |
| STEEL-SHEET-2MM | sheets | 1,200 | 46.20 |
| PALLET-WOOD | pallets | 800 | 12.10 |
| CARDBOARD-BOX-L | boxes | 15,000 | 0.86 |
| LUBRICANT-5L | cans | 300 | 33.80 |

## Public REST API (edge-gateway)

Base path `/v1`. JSON. Tenant from header `X-Tenant-Id` (default `tenant_demo`);
SSE takes `?tenant_id=` because `EventSource` cannot set headers.
Errors always look like `{"error": {"code": "...", "message": "..."}}`.

| Code | HTTP | When |
|---|---|---|
| `validation_error` | 400 | bad body/query |
| `not_found` | 404 | unknown RFQ / bid / SKU |
| `rfq_syncing` | 409 | RFQ exists but bid-service hasn't consumed `rfq.created` yet — retry in a few seconds |
| `rfq_closed` | 409 | bidding/awarding on an RFQ that isn't open |
| `pricing_unavailable` | 503 | pricing-service down or timed out (800 ms) |
| `upstream_unavailable` | 503 | any other service down |

### Resources

```ts
type PriceEstimate = {
  sku: string; quantity: number;
  estimated_unit_price: number; low: number; high: number;
  sample_size: number; cache_hit: boolean; model_version: string;
  latency_ms: number;            // measured by the gateway
};

type Rfq = {
  rfq_id: string; tenant_id: string; title: string; sku: string;
  quantity: number; unit: string; deadline: string;
  status: "open" | "awarded" | "expired"; created_at: string;
  bid_count: number;
  best_bid: { unit_price: number; supplier_name: string } | null;
  awarded: { bid_id: string; supplier_name: string; unit_price: number; awarded_at: string } | null;
  estimate: PriceEstimate | null;
  estimate_error: { code: string; message: string } | null;  // set when estimate is null because pricing failed
};

type Bid = {
  bid_id: string; rfq_id: string; supplier_id: string; supplier_name: string;
  unit_price: number; currency: "USD"; lead_time_days: number; submitted_at: string;
};

type ActivityEvent = {
  event_id: string; topic: string; event_type: string; key: string;
  occurred_at: string;
  summary: string;               // e.g. "Kestrel Fastening Co. $0.39", "CARDBOARD-BOX-L × 15,000"
  data: Record<string, unknown>;
};

type ServiceHealth = {
  name: "rfq-service" | "bid-service" | "pricing-service";
  status: "healthy" | "degraded" | "down";
  p95_ms: number | null;         // gateway-observed latency over the last 5 min
  detail: string | null;         // e.g. "3 timeouts"
};
```

### Endpoints

| Method & path | Body / query | Response |
|---|---|---|
| `GET /v1/skus` | | `{ skus: [{ sku, unit }] }` |
| `GET /v1/rfqs` | `?status=open\|awarded\|expired` | `{ rfqs: Rfq[], counts: { all, open, awarded, expired } }` (newest first; estimates fetched in parallel, cached) |
| `POST /v1/rfqs` | `{ title, sku, quantity, unit, deadline }` | `201 Rfq` |
| `GET /v1/rfqs/:rfqId` | | `Rfq` |
| `GET /v1/rfqs/:rfqId/bids` | | `{ bids: Bid[] }` (newest first) |
| `POST /v1/rfqs/:rfqId/bids` | `{ supplier_name, unit_price, lead_time_days, supplier_id? }`, header `Idempotency-Key` (optional) | `201 Bid`, or `200 Bid` on idempotent replay |
| `POST /v1/rfqs/:rfqId/award` | `{ bid_id }` | `Rfq` |
| `GET /v1/estimate` | `?sku=&qty=` | `PriceEstimate` |
| `GET /v1/health` | | `{ services: ServiceHealth[], checked_at }` |
| `GET /v1/events` | `?tenant_id=` | SSE stream (below) |
| `GET /healthz` | | `200 {"status":"ok"}` (liveness) |
| `GET /readyz` | | `200` when all upstream channels are ready, else `503` |
| `GET /openapi.json` | | OpenAPI 3 document |

### SSE `/v1/events`

- On connect: the last 50 events for the tenant, oldest first, then live ones.
- `event: activity` + `data: <ActivityEvent JSON>` for each event.
- `event: health` + `data: { services: ServiceHealth[], checked_at }` every 5 s.
- `: ping` comment every 15 s to keep proxies from closing the stream.
