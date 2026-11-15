import { describe, expect, it } from "vitest";
import { supplierIdFor, toPriceEstimate, toRestBid, toRestRfq } from "../src/mapping.js";
import { protoBid, protoEstimate, protoRfq } from "./fakes.js";

describe("toRestRfq", () => {
  it("maps absent optional fields to null objects", () => {
    const rfq = toRestRfq(protoRfq());
    expect(rfq.best_bid).toBeNull();
    expect(rfq.awarded).toBeNull();
    expect(rfq.estimate).toBeNull();
    expect(rfq.estimate_error).toBeNull();
    expect(rfq).toMatchObject({ rfq_id: "rfq_000000000001", status: "open", quantity: 40000, bid_count: 0 });
  });

  it("treats explicit nulls like absent fields", () => {
    const rfq = toRestRfq(protoRfq({ best_bid_unit_price: null, best_bid_supplier_name: null, awarded_bid_id: null }));
    expect(rfq.best_bid).toBeNull();
    expect(rfq.awarded).toBeNull();
  });

  it("nests the best bid", () => {
    const rfq = toRestRfq(protoRfq({ bid_count: 3, best_bid_unit_price: 0.39, best_bid_supplier_name: "Kestrel" }));
    expect(rfq.best_bid).toEqual({ unit_price: 0.39, supplier_name: "Kestrel" });
    expect(rfq.bid_count).toBe(3);
  });

  it("keeps a zero best price (presence, not truthiness)", () => {
    const rfq = toRestRfq(protoRfq({ best_bid_unit_price: 0, best_bid_supplier_name: "Free Co" }));
    expect(rfq.best_bid).toEqual({ unit_price: 0, supplier_name: "Free Co" });
  });

  it("nests the award", () => {
    const rfq = toRestRfq(
      protoRfq({
        status: "awarded",
        awarded_bid_id: "bid_1",
        awarded_supplier_name: "Kestrel",
        awarded_unit_price: 0.4,
        awarded_at: "2026-11-15T00:00:00Z",
      }),
    );
    expect(rfq.status).toBe("awarded");
    expect(rfq.awarded).toEqual({
      bid_id: "bid_1",
      supplier_name: "Kestrel",
      unit_price: 0.4,
      awarded_at: "2026-11-15T00:00:00Z",
    });
  });

  it("attaches an estimate or an estimate error, never both", () => {
    const estimate = toPriceEstimate(protoEstimate("BOLT-M8", 40000), 3.6);
    expect(toRestRfq(protoRfq(), { estimate, error: null })).toMatchObject({ estimate, estimate_error: null });
    const error = { code: "pricing_unavailable", message: "pricing-service timed out" };
    expect(toRestRfq(protoRfq(), { estimate: null, error })).toMatchObject({ estimate: null, estimate_error: error });
  });

  it("does not leak unknown statuses", () => {
    expect(toRestRfq(protoRfq({ status: "cancelled" })).status).toBe("expired");
  });
});

describe("toPriceEstimate", () => {
  it("adds the gateway-measured latency", () => {
    expect(toPriceEstimate(protoEstimate("NUT-M8", 100), 12.6)).toMatchObject({ sku: "NUT-M8", latency_ms: 13 });
  });
});

describe("toRestBid", () => {
  it("drops tenant_id and fixes currency", () => {
    const bid = toRestBid(protoBid());
    expect(bid).not.toHaveProperty("tenant_id");
    expect(bid).toMatchObject({ bid_id: "bid_000000000001", currency: "USD", unit_price: 0.39 });
  });
});

describe("supplierIdFor", () => {
  it("slugs the supplier name", () => {
    expect(supplierIdFor("Kestrel Fastening Co.")).toBe("sup_kestrel_fastening_co");
    expect(supplierIdFor("  Ünïted  Steel & Sons ")).toBe("sup_united_steel_sons");
    expect(supplierIdFor("!!!")).toBe("sup_unknown");
  });
});
