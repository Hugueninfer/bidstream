import { describe, expect, it } from "vitest";
import type { PriceEstimate } from "../api/types";
import { lowestBid, sortBids } from "./bids";
import { chartDomain, toPct } from "./chart";
import { classifySignal, deltaFraction, priceSignal, savingsVsEstimate } from "./pricing";
import { validateBid } from "./validation";

const est: PriceEstimate = {
  sku: "BOLT-M8",
  quantity: 40_000,
  estimated_unit_price: 0.47,
  low: 0.42,
  high: 0.53,
  sample_size: 1284,
  cache_hit: true,
  model_version: "v1",
  latency_ms: 12,
};

describe("classifySignal", () => {
  it("is good below the band", () => expect(classifySignal(0.39, 0.42, 0.53)).toBe("good"));
  it("is warn on the band edges and inside", () => {
    expect(classifySignal(0.42, 0.42, 0.53)).toBe("warn");
    expect(classifySignal(0.47, 0.42, 0.53)).toBe("warn");
    expect(classifySignal(0.53, 0.42, 0.53)).toBe("warn");
  });
  it("is bad above the band", () => expect(classifySignal(0.58, 0.42, 0.53)).toBe("bad"));
});

describe("delta vs estimate", () => {
  it("is (price − estimate) / estimate", () => {
    expect(deltaFraction(0.39, 0.47)).toBeCloseTo(-0.1702, 4);
    expect(deltaFraction(0.58, 0.47)).toBeCloseTo(0.234, 3);
    expect(deltaFraction(0.47, 0.47)).toBe(0);
  });
  it("guards against a zero estimate", () => expect(deltaFraction(1, 0)).toBe(0));

  it("pairs signal, delta and label", () => {
    expect(priceSignal(0.39, est)).toEqual({ signal: "good", delta: expect.closeTo(-0.17, 2), label: "below band" });
    expect(priceSignal(0.51, est)?.label).toBe("in band");
    expect(priceSignal(0.58, est)?.label).toBe("above band");
    expect(priceSignal(0.58, null)).toBeNull();
  });

  it("computes savings vs estimate for an award", () => {
    const s = savingsVsEstimate(0.39, 40_000, 0.47);
    expect(s.amount).toBeCloseTo(3200, 6);
    expect(s.fraction).toBeCloseTo(0.1702, 4);
    expect(savingsVsEstimate(0.58, 40_000, 0.47).amount).toBeLessThan(0);
  });
});

describe("chart domain", () => {
  it("pads the band when there are no bids", () => {
    const d = chartDomain(0.42, 0.53, []);
    expect(toPct(0.42, d)).toBeCloseTo(8.33, 1);
    expect(toPct(0.53, d)).toBeCloseTo(91.67, 1);
  });
  it("covers outlying bids", () => {
    const d = chartDomain(0.42, 0.53, [0.3, 0.7]);
    expect(toPct(0.3, d)).toBeGreaterThan(0);
    expect(toPct(0.7, d)).toBeLessThan(100);
  });
  it("handles a degenerate band", () => {
    const d = chartDomain(1, 1, []);
    expect(d[0]).toBeLessThan(1);
    expect(d[1]).toBeGreaterThan(1);
  });
});

describe("bids", () => {
  const mk = (id: string, name: string, price: number, lead: number, at: string) => ({
    bid_id: id,
    rfq_id: "rfq_1",
    supplier_id: "sup_x",
    supplier_name: name,
    unit_price: price,
    currency: "USD" as const,
    lead_time_days: lead,
    submitted_at: at,
  });
  const bids = [
    mk("bid_a", "Northgate", 0.58, 10, "2026-11-14T14:01:47Z"),
    mk("bid_b", "Kestrel", 0.39, 21, "2026-11-14T14:02:11Z"),
    mk("bid_c", "Halvard", 0.51, 6, "2026-11-14T13:51:19Z"),
  ];
  it("sorts by price, lead time, supplier and submitted", () => {
    expect(sortBids(bids, "unit_price", "asc").map((b) => b.bid_id)).toEqual(["bid_b", "bid_c", "bid_a"]);
    expect(sortBids(bids, "lead_time", "desc").map((b) => b.bid_id)).toEqual(["bid_b", "bid_a", "bid_c"]);
    expect(sortBids(bids, "supplier", "asc").map((b) => b.supplier_name)).toEqual(["Halvard", "Kestrel", "Northgate"]);
    expect(sortBids(bids, "submitted", "desc").map((b) => b.bid_id)).toEqual(["bid_b", "bid_a", "bid_c"]);
  });
  it("does not mutate the input", () => {
    const copy = [...bids];
    sortBids(bids, "unit_price", "asc");
    expect(bids).toEqual(copy);
  });
  it("finds the lowest bid", () => {
    expect(lowestBid(bids)?.bid_id).toBe("bid_b");
    expect(lowestBid([])).toBeNull();
  });
});

describe("bid form validation", () => {
  it("matches the design's three messages", () => {
    expect(validateBid("", "0", "2.5")).toEqual({
      name: "Enter the name buyers will see on your bid.",
      price: "Enter a price greater than $0.",
      lead: "Whole days between 1 and 365.",
    });
  });
  it("accepts a valid bid", () => expect(validateBid("Brackwater Components", "0.45", "15")).toEqual({}));
  it("bounds lead time", () => {
    expect(validateBid("x", "1", "0").lead).toBeDefined();
    expect(validateBid("x", "1", "366").lead).toBeDefined();
    expect(validateBid("x", "1", "365").lead).toBeUndefined();
  });
});
