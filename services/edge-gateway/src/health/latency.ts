export type CallOutcome = "ok" | "timeout" | "unavailable" | "error";

type Sample = { at: number; ms: number; outcome: CallOutcome };

export type LatencyStats = {
  count: number;
  p95Ms: number | null;
  timeouts: number;
  unavailable: number;
};

export const DEFAULT_WINDOW_MS = 5 * 60_000;

/** Nearest-rank percentile (p in 0..100) of an unsorted list; null when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

/**
 * Rolling window of call samples for one upstream. Samples arrive in time
 * order, so eviction only ever drops from the front.
 */
export class LatencyRecorder {
  private samples: Sample[] = [];
  private readonly windowMs: number;
  private readonly maxSamples: number;
  private readonly now: () => number;

  constructor(opts: { windowMs?: number; maxSamples?: number; now?: () => number } = {}) {
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.maxSamples = opts.maxSamples ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  record(ms: number, outcome: CallOutcome): void {
    this.samples.push({ at: this.now(), ms, outcome });
    if (this.samples.length > this.maxSamples) this.samples.shift();
    this.evict();
  }

  stats(): LatencyStats {
    this.evict();
    let timeouts = 0;
    let unavailable = 0;
    for (const s of this.samples) {
      if (s.outcome === "timeout") timeouts++;
      else if (s.outcome === "unavailable") unavailable++;
    }
    const p95 = percentile(
      this.samples.map((s) => s.ms),
      95,
    );
    return {
      count: this.samples.length,
      p95Ms: p95 === null ? null : Math.round(p95),
      timeouts,
      unavailable,
    };
  }

  private evict(): void {
    const cutoff = this.now() - this.windowMs;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop]!.at <= cutoff) drop++;
    if (drop > 0) this.samples.splice(0, drop);
  }
}
