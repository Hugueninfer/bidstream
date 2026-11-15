import { formatSignedPct } from "../lib/format";
import type { PriceSignal } from "../lib/pricing";
import { SIGNAL_SOFT } from "../lib/signalStyles";

/** "−17.0% · below band" pill (signed % + text label + colour). */
export function PricePill({ s }: { s: PriceSignal }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-sm px-1.5 py-0.5 text-caption font-medium tabular-nums ${SIGNAL_SOFT[s.signal]}`}
    >
      {formatSignedPct(s.delta)} · {s.label}
    </span>
  );
}
