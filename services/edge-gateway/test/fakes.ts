import { status } from "@grpc/grpc-js";
import { ActivityHub } from "../src/activity/hub.js";
import { buildApp, type AppDeps } from "../src/app.js";
import { UpstreamError } from "../src/clients/errors.js";
import type {
  BidClient,
  PricingClient,
  ProtoBid,
  ProtoPriceEstimate,
  ProtoRfq,
  RfqClient,
  SubmitBidInput,
} from "../src/clients/types.js";
import type { HealthReporter } from "../src/health/monitor.js";
import type { ActivityEvent, HealthSnapshot, ServiceName } from "../src/types.js";

export const upstreamError = (service: ServiceName, code: status, details = "boom") =>
  new UpstreamError(service, code, details);

export function protoRfq(overrides: Partial<ProtoRfq> = {}): ProtoRfq {
  return {
    rfq_id: "rfq_000000000001",
    tenant_id: "tenant_demo",
    title: "Bolts for line 3",
    sku: "BOLT-M8",
    quantity: 40000,
    unit: "pcs",
    deadline: "2026-11-20T17:00:00Z",
    status: "open",
    created_at: "2026-11-14T10:00:00Z",
    bid_count: 0,
    ...overrides,
  };
}

export function protoBid(overrides: Partial<ProtoBid> = {}): ProtoBid {
  return {
    bid_id: "bid_000000000001",
    tenant_id: "tenant_demo",
    rfq_id: "rfq_000000000001",
    supplier_id: "sup_kestrel_fastening_co",
    supplier_name: "Kestrel Fastening Co.",
    unit_price: 0.39,
    currency: "USD",
    lead_time_days: 7,
    submitted_at: "2026-11-14T11:00:00Z",
    ...overrides,
  };
}

export function protoEstimate(sku: string, quantity: number): ProtoPriceEstimate {
  return {
    sku,
    quantity,
    estimated_unit_price: 0.47,
    low: 0.41,
    high: 0.53,
    sample_size: 1100,
    cache_hit: false,
    model_version: "v1",
  };
}

export class FakeRfq implements RfqClient {
  rfqs: ProtoRfq[] = [];
  error: UpstreamError | null = null;
  awardError: UpstreamError | null = null;
  calls: string[] = [];

  private fail() {
    if (this.error) throw this.error;
  }
  async createRfq(input: Parameters<RfqClient["createRfq"]>[0]) {
    this.fail();
    this.calls.push("CreateRfq");
    const rfq = protoRfq({ ...input, rfq_id: "rfq_00000000000f" });
    this.rfqs.push(rfq);
    return rfq;
  }
  async getRfq(tenantId: string, rfqId: string) {
    this.fail();
    this.calls.push(`GetRfq:${rfqId}`);
    const found = this.rfqs.find((r) => r.rfq_id === rfqId && r.tenant_id === tenantId);
    if (!found) throw upstreamError("rfq-service", status.NOT_FOUND, `rfq ${rfqId} not found`);
    return found;
  }
  async listRfqs(tenantId: string, statusFilter = "") {
    this.fail();
    this.calls.push(`ListRfqs:${statusFilter}`);
    return this.rfqs.filter((r) => r.tenant_id === tenantId && (!statusFilter || r.status === statusFilter));
  }
  async awardRfq(tenantId: string, rfqId: string, bidId: string) {
    this.fail();
    if (this.awardError) throw this.awardError;
    const rfq = await this.getRfq(tenantId, rfqId);
    return { ...rfq, status: "awarded", awarded_bid_id: bidId, awarded_supplier_name: "Kestrel Fastening Co.", awarded_unit_price: 0.39, awarded_at: "2026-11-14T12:00:00Z" };
  }
}

export class FakeBid implements BidClient {
  bids: ProtoBid[] = [];
  error: UpstreamError | null = null;
  replay = false;
  lastInput: SubmitBidInput | null = null;

  async submitBid(input: SubmitBidInput) {
    this.lastInput = input;
    if (this.error) throw this.error;
    const bid = protoBid({ ...input, bid_id: "bid_00000000000a" });
    return { bid, replay: this.replay };
  }
  async listBids(_tenantId: string, rfqId: string) {
    if (this.error) throw this.error;
    return this.bids.filter((b) => b.rfq_id === rfqId);
  }
}

export class FakePricing implements PricingClient {
  /** Errors by SKU. */
  failures = new Map<string, UpstreamError>();
  calls: string[] = [];

  async getPriceEstimate(sku: string, quantity: number) {
    this.calls.push(`${sku}:${quantity}`);
    const failure = this.failures.get(sku);
    if (failure) throw failure;
    return { estimate: protoEstimate(sku, quantity), latencyMs: 12.4 };
  }
}

export class FakeHealth implements HealthReporter {
  ready = true;
  snapshot(): HealthSnapshot {
    return {
      services: (["rfq-service", "bid-service", "pricing-service"] as const).map((name) => ({
        name,
        status: "healthy",
        p95_ms: 10,
        detail: null,
      })),
      checked_at: "2026-11-14T12:00:00Z",
    };
  }
  readiness() {
    return { ready: this.ready, channels: { "rfq-service": this.ready, "bid-service": true, "pricing-service": true } };
  }
}

export function activityEvent(n: number, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  const ts = new Date(Date.UTC(2026, 10, 14, 12, 0, n)).toISOString().replace(".000Z", "Z");
  return {
    event_id: `evt-${n}`,
    topic: "rfq.events",
    event_type: "rfq.created",
    key: `rfq_${n}`,
    occurred_at: ts,
    summary: `BOLT-M8 × ${n}`,
    data: { n },
    ...overrides,
  };
}

export async function makeApp(overrides: Partial<AppDeps> = {}) {
  const rfq = new FakeRfq();
  const bid = new FakeBid();
  const pricing = new FakePricing();
  const health = new FakeHealth();
  const activity = new ActivityHub();
  const app = await buildApp({
    upstreams: { rfq, bid, pricing },
    health,
    activity,
    corsOrigins: ["http://localhost:5173"],
    ...overrides,
  });
  return { app, rfq, bid, pricing, health, activity };
}
