import { describe, expect, it } from "vitest";
import { LatencyRecorder, percentile } from "../src/health/latency.js";

describe("percentile", () => {
  it("uses nearest rank", () => {
    expect(percentile([], 95)).toBeNull();
    expect(percentile([42], 95)).toBe(42);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1).reverse();
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 1000], 95)).toBe(1000);
    expect(percentile([10, 20], 50)).toBe(10);
  });
});

describe("LatencyRecorder", () => {
  it("computes p95 and counts failures within the window", () => {
    let now = 0;
    const rec = new LatencyRecorder({ windowMs: 1000, now: () => now });
    for (let i = 1; i <= 20; i++) rec.record(i * 10, "ok");
    rec.record(800, "timeout");
    rec.record(5, "unavailable");
    const stats = rec.stats();
    expect(stats).toEqual({ count: 22, p95Ms: 200, timeouts: 1, unavailable: 1 });
  });

  it("evicts samples older than the window", () => {
    let now = 0;
    const rec = new LatencyRecorder({ windowMs: 5 * 60_000, now: () => now });
    rec.record(900, "timeout");
    now = 4 * 60_000;
    rec.record(20, "ok");
    expect(rec.stats()).toMatchObject({ count: 2, timeouts: 1, p95Ms: 900 });
    now = 5 * 60_000 + 1;
    expect(rec.stats()).toEqual({ count: 1, p95Ms: 20, timeouts: 0, unavailable: 0 });
    now = 10 * 60_000;
    expect(rec.stats()).toEqual({ count: 0, p95Ms: null, timeouts: 0, unavailable: 0 });
  });

  it("caps memory", () => {
    const rec = new LatencyRecorder({ maxSamples: 3 });
    for (const ms of [1, 2, 3, 4]) rec.record(ms, "ok");
    expect(rec.stats().count).toBe(3);
  });
});
