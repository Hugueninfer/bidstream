CREATE TABLE rfqs (
  rfq_id                 TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL,
  title                  TEXT NOT NULL,
  sku                    TEXT NOT NULL,
  quantity               BIGINT NOT NULL CHECK (quantity > 0),
  unit                   TEXT NOT NULL,
  deadline               TIMESTAMPTZ NOT NULL,
  -- 'expired' is never stored: it is computed at read time from status + deadline.
  status                 TEXT NOT NULL CHECK (status IN ('open', 'awarded')),
  created_at             TIMESTAMPTZ NOT NULL,
  bid_count              INT NOT NULL DEFAULT 0,
  best_bid_unit_price    NUMERIC(12,4),
  best_bid_supplier_name TEXT,
  awarded_bid_id         TEXT,
  awarded_supplier_name  TEXT,
  awarded_unit_price     NUMERIC(12,4),
  awarded_at             TIMESTAMPTZ
);
CREATE INDEX rfqs_tenant_created ON rfqs (tenant_id, created_at DESC);

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

CREATE TABLE processed_events (
  event_id     UUID NOT NULL,
  consumer     TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);
