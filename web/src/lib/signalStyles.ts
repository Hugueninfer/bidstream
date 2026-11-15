import type { Signal } from "./pricing";

/** Token classes for the price signal (always paired with a signed % and a text label). */
export const SIGNAL_TEXT: Record<Signal, string> = { good: "text-good", warn: "text-warn", bad: "text-bad" };
export const SIGNAL_BG: Record<Signal, string> = { good: "bg-good", warn: "bg-warn", bad: "bg-bad" };
export const SIGNAL_SOFT: Record<Signal, string> = {
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
};
