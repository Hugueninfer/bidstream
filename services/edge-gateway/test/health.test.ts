import { describe, expect, it } from "vitest";
import { LatencyRecorder, type LatencyStats } from "../src/health/latency.js";
import { HealthMonitor, type HealthProbe } from "../src/health/monitor.js";
import { evaluateHealth, type ProbeResult } from "../src/health/status.js";
import type { ServiceName } from "../src/types.js";

const stats = (s: Partial<LatencyStats> = {}): LatencyStats => ({ count: 10, p95Ms: 40, timeouts: 0, unavailable: 0, ...s });

describe("evaluateHealth", () => {
  it("is healthy when the probe passes and the window is clean", () => {
    expect(evaluateHealth("rfq-service", { ok: true }, stats())).toEqual({
      name: "rfq-service",
      status: "healthy",
      p95_ms: 40,
      detail: null,
    });
  });

  it("is down when the probe fails, whatever the latency", () => {
    expect(evaluateHealth("bid-service", { ok: false, reason: "unreachable" }, stats())).toMatchObject({
      status: "down",
      detail: "unreachable",
    });
    expect(evaluateHealth("bid-service", undefined, stats()).status).toBe("down");
  });

  it("is degraded on timeouts or unavailable errors in the window", () => {
    expect(evaluateHealth("pricing-service", { ok: true }, stats({ timeouts: 3 }))).toMatchObject({
      status: "degraded",
      detail: "3 timeouts",
    });
    expect(evaluateHealth("pricing-service", { ok: true }, stats({ timeouts: 1, unavailable: 2 }))).toMatchObject({
      status: "degraded",
      detail: "1 timeout, 2 unavailable",
    });
  });

  it("is degraded when p95 exceeds 500 ms", () => {
    expect(evaluateHealth("rfq-service", { ok: true }, stats({ p95Ms: 501 }))).toMatchObject({
      status: "degraded",
      detail: "p95 501 ms",
    });
    expect(evaluateHealth("rfq-service", { ok: true }, stats({ p95Ms: 500 })).status).toBe("healthy");
  });

  it("reports p95 null without traffic", () => {
    expect(evaluateHealth("rfq-service", { ok: true }, stats({ count: 0, p95Ms: null }))).toMatchObject({
      status: "healthy",
      p95_ms: null,
    });
  });
});

class StubProbe implements HealthProbe {
  constructor(
    readonly name: ServiceName,
    public result: ProbeResult,
    public ready = true,
  ) {}
  async check() {
    return this.result;
  }
  isReady() {
    return this.ready;
  }
}

describe("HealthMonitor", () => {
  it("combines probes and recorders into a snapshot", async () => {
    const probes = [
      new StubProbe("rfq-service", { ok: true }),
      new StubProbe("bid-service", { ok: false, reason: "unreachable" }, false),
      new StubProbe("pricing-service", { ok: true }),
    ];
    const recorders = new Map<ServiceName, LatencyRecorder>(probes.map((p) => [p.name, new LatencyRecorder()]));
    recorders.get("pricing-service")!.record(800, "timeout");
    const monitor = new HealthMonitor(probes, recorders);

    expect(monitor.snapshot().services.every((s) => s.status === "down")).toBe(true);
    await monitor.probeAll();
    const snap = monitor.snapshot();
    expect(snap.services.map((s) => [s.name, s.status])).toEqual([
      ["rfq-service", "healthy"],
      ["bid-service", "down"],
      ["pricing-service", "degraded"],
    ]);
    expect(snap.checked_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(monitor.readiness()).toEqual({
      ready: false,
      channels: { "rfq-service": true, "bid-service": false, "pricing-service": true },
    });
  });
});
