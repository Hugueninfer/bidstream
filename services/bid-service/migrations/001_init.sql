-- Bids submitted by suppliers. Money is NUMERIC(12,4) in USD (see docs/contracts.md).
CREATE TABLE bids (
  bid_id          TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  rfq_id          TEXT NOT NULL,
  supplier_id     TEXT NOT NULL,
  supplier_name   TEXT NOT NULL,
  unit_price      NUMERIC(12,4) NOT NULL CHECK (unit_price > 0),
  currency        TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  lead_time_days  INT NOT NULL CHECK (lead_time_days BETWEEN 0 AND 365),
  submitted_at    TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NULL,
  -- NULL keys never conflict, so bids without a key are unaffected.
  CONSTRAINT bids_tenant_idempotency_key UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX bids_tenant_rfq_submitted ON bids (tenant_id, rfq_id, submitted_at DESC);

-- Local read model of RFQs, fed by rfq.events; used to validate bids without
-- calling rfq-service.
CREATE TABLE rfq_view (
  rfq_id     TEXT PRIMARY KEY,
  tenant_id  TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('open', 'awarded')),
  deadline   TIMESTAMPTZ NOT NULL,
  quantity   BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Transactional outbox, drained by the relay into Kafka.
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

-- Consumer-side deduplication: one row per (event, consumer) handled.
CREATE TABLE processed_events (
  event_id     UUID NOT NULL,
  consumer     TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);
