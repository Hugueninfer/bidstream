// Upstream message shapes as decoded by @grpc/proto-loader (keepCase, longs: Number,
// defaults: true, oneofs: true). proto3 `optional` fields that are unset are absent,
// so they are typed as optional and may also arrive as null from hand-written fakes.

export type ProtoRfq = {
  rfq_id: string;
  tenant_id: string;
  title: string;
  sku: string;
  quantity: number;
  unit: string;
  deadline: string;
  status: string;
  created_at: string;
  bid_count: number;
  best_bid_unit_price?: number | null;
  best_bid_supplier_name?: string | null;
  awarded_bid_id?: string | null;
  awarded_supplier_name?: string | null;
  awarded_unit_price?: number | null;
  awarded_at?: string | null;
};

export type ProtoBid = {
  bid_id: string;
  tenant_id: string;
  rfq_id: string;
  supplier_id: string;
  supplier_name: string;
  unit_price: number;
  currency: string;
  lead_time_days: number;
  submitted_at: string;
};

export type ProtoPriceEstimate = {
  sku: string;
  quantity: number;
  estimated_unit_price: number;
  low: number;
  high: number;
  sample_size: number;
  cache_hit: boolean;
  model_version: string;
};

export type CreateRfqInput = {
  tenant_id: string;
  title: string;
  sku: string;
  quantity: number;
  unit: string;
  deadline: string;
};

export type SubmitBidInput = {
  tenant_id: string;
  rfq_id: string;
  supplier_id: string;
  supplier_name: string;
  unit_price: number;
  lead_time_days: number;
  idempotency_key: string;
};

/** The narrow surface the routes need. Real implementations speak gRPC; tests use fakes. */
export interface RfqClient {
  createRfq(input: CreateRfqInput): Promise<ProtoRfq>;
  getRfq(tenantId: string, rfqId: string): Promise<ProtoRfq>;
  /** status "" lists every RFQ. */
  listRfqs(tenantId: string, status?: string): Promise<ProtoRfq[]>;
  awardRfq(tenantId: string, rfqId: string, bidId: string): Promise<ProtoRfq>;
}

export interface BidClient {
  /** `replay` is true when bid-service answered from its idempotency store. */
  submitBid(input: SubmitBidInput): Promise<{ bid: ProtoBid; replay: boolean }>;
  listBids(tenantId: string, rfqId: string): Promise<ProtoBid[]>;
}

export interface PricingClient {
  /** `latencyMs` is the round trip observed by the gateway. */
  getPriceEstimate(sku: string, quantity: number): Promise<{ estimate: ProtoPriceEstimate; latencyMs: number }>;
}

export type Upstreams = { rfq: RfqClient; bid: BidClient; pricing: PricingClient };
