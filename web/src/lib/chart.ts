/**
 * Price axis for PriceBandChart: covers the band and every bid, padded so the band
 * and the outermost dots sit inside the track (≈8–92 % when there are no bids).
 */
export function chartDomain(low: number, high: number, prices: number[]): [number, number] {
  const finite = prices.filter(Number.isFinite);
  let lo = Math.min(low, ...finite);
  let hi = Math.max(high, ...finite);
  if (!(hi > lo)) {
    const mid = Number.isFinite(lo) ? lo : 0;
    const d = Math.abs(mid) * 0.1 || 1;
    lo = mid - d;
    hi = mid + d;
  }
  const pad = (hi - lo) * 0.1;
  return [lo - pad, hi + pad];
}

/** Position of `v` on the domain as a percentage clamped to [0, 100]. */
export function toPct(v: number, [lo, hi]: [number, number]): number {
  if (!(hi > lo)) return 50;
  return Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
}
