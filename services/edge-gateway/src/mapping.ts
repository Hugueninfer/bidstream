import type { ProtoBid, ProtoPriceEstimate, ProtoRfq } from "./clients/types.js";
import type { Bid, ErrorBody, PriceEstimate, Rfq, RfqStatus } from "./types.js";
import { RFQ_STATUSES } from "./types.js";

export type EstimateResult = { estimate: PriceEstimate | null; error: ErrorBody | null };

const present = <T>(v: T | null | undefined): v is T => v !== undefined && v !== null;

function toStatus(status: string): RfqStatus {
  // An unknown status from a newer rfq-service is safest shown as not biddable.
  return (RFQ_STATUSES as readonly string[]).includes(status) ? (status as RfqStatus) : "expired";
}

/** Converts proto `Rfq` (flat optional fields) into the REST `Rfq` (nested objects or null). */
export function toRestRfq(rfq: ProtoRfq, est: EstimateResult = { estimate: null, error: null }): Rfq {
  const bestBid =
    present(rfq.best_bid_unit_price) && present(rfq.best_bid_supplier_name)
      ? { unit_price: rfq.best_bid_unit_price, supplier_name: rfq.best_bid_supplier_name }
      : null;

  const awarded =
    present(rfq.awarded_bid_id) && rfq.awarded_bid_id !== ""
      ? {
          bid_id: rfq.awarded_bid_id,
          supplier_name: rfq.awarded_supplier_name ?? "",
          unit_price: rfq.awarded_unit_price ?? 0,
          awarded_at: rfq.awarded_at ?? "",
        }
      : null;

  return {
    rfq_id: rfq.rfq_id,
    tenant_id: rfq.tenant_id,
    title: rfq.title,
    sku: rfq.sku,
    quantity: rfq.quantity,
    unit: rfq.unit,
    deadline: rfq.deadline,
    status: toStatus(rfq.status),
    created_at: rfq.created_at,
    bid_count: rfq.bid_count ?? 0,
    best_bid: bestBid,
    awarded,
    estimate: est.estimate,
    estimate_error: est.estimate ? null : est.error,
  };
}

export function toRestBid(bid: ProtoBid): Bid {
  return {
    bid_id: bid.bid_id,
    rfq_id: bid.rfq_id,
    supplier_id: bid.supplier_id,
    supplier_name: bid.supplier_name,
    unit_price: bid.unit_price,
    currency: "USD",
    lead_time_days: bid.lead_time_days,
    submitted_at: bid.submitted_at,
  };
}

export function toPriceEstimate(e: ProtoPriceEstimate, latencyMs: number): PriceEstimate {
  return {
    sku: e.sku,
    quantity: e.quantity,
    estimated_unit_price: e.estimated_unit_price,
    low: e.low,
    high: e.high,
    sample_size: e.sample_size,
    cache_hit: e.cache_hit,
    model_version: e.model_version,
    latency_ms: Math.round(latencyMs),
  };
}

/** `sup_` + slug of the supplier name, per docs/contracts.md. */
export function supplierIdFor(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `sup_${slug || "unknown"}`;
}
