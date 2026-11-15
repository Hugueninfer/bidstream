import { isUpstreamError } from "./clients/errors.js";
import type { PricingClient, ProtoRfq } from "./clients/types.js";
import { fromUpstream } from "./errors.js";
import { toPriceEstimate, toRestRfq, type EstimateResult } from "./mapping.js";
import type { Rfq } from "./types.js";

/** Fetches one estimate; a pricing failure becomes `estimate_error`, never an exception. */
export async function fetchEstimate(pricing: PricingClient, sku: string, quantity: number): Promise<EstimateResult> {
  try {
    const { estimate, latencyMs } = await pricing.getPriceEstimate(sku, quantity);
    return { estimate: toPriceEstimate(estimate, latencyMs), error: null };
  } catch (err) {
    if (isUpstreamError(err)) {
      const api = fromUpstream(err);
      return { estimate: null, error: { code: api.code, message: api.message } };
    }
    return { estimate: null, error: { code: "pricing_unavailable", message: "pricing-service call failed" } };
  }
}

/** Attaches estimates, asking pricing once per distinct (sku, quantity) pair, all in parallel. */
export async function withEstimates(pricing: PricingClient, rfqs: readonly ProtoRfq[]): Promise<Rfq[]> {
  const pending = new Map<string, Promise<EstimateResult>>();
  const keyOf = (r: ProtoRfq) => `${r.sku}\u0000${r.quantity}`;
  for (const r of rfqs) {
    if (!pending.has(keyOf(r))) pending.set(keyOf(r), fetchEstimate(pricing, r.sku, r.quantity));
  }
  return Promise.all(rfqs.map(async (r) => toRestRfq(r, await pending.get(keyOf(r))!)));
}

export async function withEstimate(pricing: PricingClient, rfq: ProtoRfq): Promise<Rfq> {
  return toRestRfq(rfq, await fetchEstimate(pricing, rfq.sku, rfq.quantity));
}
