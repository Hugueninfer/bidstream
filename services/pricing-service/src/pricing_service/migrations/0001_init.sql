CREATE TABLE price_observations (
  id          BIGSERIAL PRIMARY KEY,
  sku         TEXT NOT NULL,
  quantity    BIGINT NOT NULL CHECK (quantity > 0),
  unit_price  NUMERIC(12,4) NOT NULL CHECK (unit_price > 0),
  source      TEXT NOT NULL CHECK (source IN ('seed', 'award')),
  observed_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX price_observations_sku ON price_observations (sku);

CREATE TABLE processed_events (
  event_id     UUID NOT NULL,
  consumer     TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer)
);
