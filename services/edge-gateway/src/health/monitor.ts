import type { HealthSnapshot, ServiceName } from "../types.js";
import type { LatencyRecorder } from "./latency.js";
import { evaluateHealth, type ProbeResult } from "./status.js";
import { rfc3339 } from "../time.js";

export interface HealthProbe {
  readonly name: ServiceName;
  /** Runs grpc.health.v1.Health/Check; never rejects. */
  check(): Promise<ProbeResult>;
  /** True when the underlying channel is READY. */
  isReady(): boolean;
}

export type Readiness = { ready: boolean; channels: Record<string, boolean> };

/** What the HTTP layer needs to know about upstream health. */
export interface HealthReporter {
  snapshot(): HealthSnapshot;
  readiness(): Readiness;
}

export const PROBE_INTERVAL_MS = 5_000;

export class HealthMonitor implements HealthReporter {
  private readonly lastProbe = new Map<ServiceName, ProbeResult>();
  private checkedAt: Date | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly probes: readonly HealthProbe[],
    private readonly recorders: ReadonlyMap<ServiceName, LatencyRecorder>,
    private readonly intervalMs = PROBE_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.probeAll();
    this.timer = setInterval(() => void this.probeAll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async probeAll(): Promise<void> {
    const results = await Promise.all(this.probes.map(async (p) => [p.name, await p.check()] as const));
    for (const [name, result] of results) this.lastProbe.set(name, result);
    this.checkedAt = new Date();
  }

  snapshot(): HealthSnapshot {
    const services = this.probes.map((p) => {
      const stats = this.recorders.get(p.name)?.stats() ?? { count: 0, p95Ms: null, timeouts: 0, unavailable: 0 };
      return evaluateHealth(p.name, this.lastProbe.get(p.name), stats);
    });
    return { services, checked_at: rfc3339(this.checkedAt ?? new Date()) };
  }

  readiness(): Readiness {
    const channels = Object.fromEntries(this.probes.map((p) => [p.name, p.isReady()]));
    return { ready: Object.values(channels).every(Boolean), channels };
  }
}
