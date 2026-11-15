// Verbatim from docs/contracts.md → "Public REST API (edge-gateway)". Keep in sync.

export type PriceEstimate = {
  sku: string; quantity: number;
  estimated_unit_price: number; low: number; high: number;
  sample_size: number; cache_hit: boolean; model_version: string;
  latency_ms: number;            // measured by the gateway
};

export type Rfq = {
  rfq_id: string; tenant_id: string; title: string; sku: string;
  quantity: number; unit: string; deadline: string;
  status: "open" | "awarded" | "expired"; created_at: string;
  bid_count: number;
  best_bid: { unit_price: number; supplier_name: string } | null;
  awarded: { bid_id: string; supplier_name: string; unit_price: number; awarded_at: string } | null;
  estimate: PriceEstimate | null;
  estimate_error: { code: string; message: string } | null;  // set when estimate is null because pricing failed
};

export type Bid = {
  bid_id: string; rfq_id: string; supplier_id: string; supplier_name: string;
  unit_price: number; currency: "USD"; lead_time_days: number; submitted_at: string;
};

export type ActivityEvent = {
  event_id: string; topic: string; event_type: string; key: string;
  occurred_at: string;
  summary: string;               // e.g. "Kestrel Fastening Co. $0.39", "CARDBOARD-BOX-L × 15,000"
  data: Record<string, unknown>;
};

export type ServiceHealth = {
  name: "rfq-service" | "bid-service" | "pricing-service";
  status: "healthy" | "degraded" | "down";
  p95_ms: number | null;         // gateway-observed latency over the last 5 min
  detail: string | null;         // e.g. "3 timeouts"
};

// ---- Endpoint payloads (from the endpoint table) ----

export type RfqStatus = Rfq["status"];

export type SkusResponse = { skus: { sku: string; unit: string }[] };

export type RfqListResponse = {
  rfqs: Rfq[];
  counts: { all: number; open: number; awarded: number; expired: number };
};

export type CreateRfqRequest = {
  title: string; sku: string; quantity: number; unit: string; deadline: string;
};

export type BidsResponse = { bids: Bid[] };

export type CreateBidRequest = {
  supplier_name: string; unit_price: number; lead_time_days: number; supplier_id?: string;
};

export type AwardRequest = { bid_id: string };

export type HealthResponse = { services: ServiceHealth[]; checked_at: string };

export type ApiErrorCode =
  | "validation_error"
  | "not_found"
  | "rfq_syncing"
  | "rfq_closed"
  | "pricing_unavailable"
  | "upstream_unavailable";

export type ApiErrorEnvelope = { error: { code: string; message: string } };
