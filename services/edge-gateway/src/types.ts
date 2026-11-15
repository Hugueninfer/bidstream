// Public REST shapes, as specified in docs/contracts.md ("Public REST API").

export type ServiceName = "rfq-service" | "bid-service" | "pricing-service";
export const SERVICE_NAMES: readonly ServiceName[] = ["rfq-service", "bid-service", "pricing-service"];

export type RfqStatus = "open" | "awarded" | "expired";
export const RFQ_STATUSES: readonly RfqStatus[] = ["open", "awarded", "expired"];

export type PriceEstimate = {
  sku: string;
  quantity: number;
  estimated_unit_price: number;
  low: number;
  high: number;
  sample_size: number;
  cache_hit: boolean;
  model_version: string;
  latency_ms: number;
};

export type ErrorBody = { code: string; message: string };

export type Rfq = {
  rfq_id: string;
  tenant_id: string;
  title: string;
  sku: string;
  quantity: number;
  unit: string;
  deadline: string;
  status: RfqStatus;
  created_at: string;
  bid_count: number;
  best_bid: { unit_price: number; supplier_name: string } | null;
  awarded: { bid_id: string; supplier_name: string; unit_price: number; awarded_at: string } | null;
  estimate: PriceEstimate | null;
  estimate_error: ErrorBody | null;
};

export type Bid = {
  bid_id: string;
  rfq_id: string;
  supplier_id: string;
  supplier_name: string;
  unit_price: number;
  currency: "USD";
  lead_time_days: number;
  submitted_at: string;
};

export type ActivityEvent = {
  event_id: string;
  topic: string;
  event_type: string;
  key: string;
  occurred_at: string;
  summary: string;
  data: Record<string, unknown>;
};

export type HealthStatus = "healthy" | "degraded" | "down";

export type ServiceHealth = {
  name: ServiceName;
  status: HealthStatus;
  p95_ms: number | null;
  detail: string | null;
};

export type HealthSnapshot = { services: ServiceHealth[]; checked_at: string };
