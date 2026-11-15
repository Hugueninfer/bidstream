import type { PriceEstimate } from "../api/types";

/** Price signal rule from the token sheet. */
export type Signal = "good" | "warn" | "bad";

export function classifySignal(price: number, low: number, high: number): Signal {
  if (price < low) return "good";
  if (price > high) return "bad";
  return "warn";
}

export const SIGNAL_LABEL: Record<Signal, string> = {
  good: "below band",
  warn: "in band",
  bad: "above band",
};

/** Δ % = (price − estimate) / estimate, as a fraction. */
export function deltaFraction(price: number, estimate: number): number {
  if (!Number.isFinite(estimate) || estimate === 0) return 0;
  return (price - estimate) / estimate;
}

export type PriceSignal = { signal: Signal; delta: number; label: string };

export function priceSignal(price: number, est: PriceEstimate | null | undefined): PriceSignal | null {
  if (!est) return null;
  const signal = classifySignal(price, est.low, est.high);
  return { signal, delta: deltaFraction(price, est.estimated_unit_price), label: SIGNAL_LABEL[signal] };
}

/** Savings vs estimate for awarding at `price` × `quantity` (positive = cheaper than predicted). */
export function savingsVsEstimate(price: number, quantity: number, estimate: number) {
  const amount = (estimate - price) * quantity;
  const fraction = estimate === 0 ? 0 : (estimate - price) / estimate;
  return { amount, fraction };
}
