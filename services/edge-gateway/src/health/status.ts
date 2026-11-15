import type { ServiceHealth, ServiceName } from "../types.js";
import type { LatencyStats } from "./latency.js";

export type ProbeResult = { ok: true } | { ok: false; reason: string };

export const SLOW_P95_MS = 500;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * - down: the last health probe failed (or none has completed yet)
 * - degraded: timeouts/unavailable errors in the window, or p95 above 500 ms
 * - healthy: otherwise
 */
export function evaluateHealth(
  name: ServiceName,
  probe: ProbeResult | undefined,
  stats: LatencyStats,
): ServiceHealth {
  const p95_ms = stats.p95Ms;
  if (!probe) return { name, status: "down", p95_ms, detail: "not probed yet" };
  if (!probe.ok) return { name, status: "down", p95_ms, detail: probe.reason };

  const problems: string[] = [];
  if (stats.timeouts > 0) problems.push(plural(stats.timeouts, "timeout"));
  if (stats.unavailable > 0) problems.push(`${stats.unavailable} unavailable`);
  if (p95_ms !== null && p95_ms > SLOW_P95_MS) problems.push(`p95 ${p95_ms} ms`);

  return problems.length > 0
    ? { name, status: "degraded", p95_ms, detail: problems.join(", ") }
    : { name, status: "healthy", p95_ms, detail: null };
}
