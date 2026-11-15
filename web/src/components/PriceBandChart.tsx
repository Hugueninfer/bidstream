import type { Bid, PriceEstimate } from "../api/types";
import { chartDomain, toPct } from "../lib/chart";
import { formatSignedPct, formatUnitPrice } from "../lib/format";
import { classifySignal, deltaFraction, SIGNAL_LABEL, type Signal } from "../lib/pricing";
import { SIGNAL_BG } from "../lib/signalStyles";
import { Dot } from "./ui";

/** Band (low–high), estimate tick and one dot per bid coloured by price signal; the winner is ringed. */
export function PriceBandChart({
  estimate,
  bids,
  winnerBidId,
}: {
  estimate: PriceEstimate;
  bids: Bid[];
  winnerBidId?: string | null;
}) {
  const { low, high, estimated_unit_price: est } = estimate;
  const domain = chartDomain(low, high, bids.map((b) => b.unit_price));
  const lowPct = toPct(low, domain);
  const highPct = toPct(high, domain);
  const estPct = toPct(est, domain);

  const counts: Record<Signal, number> = { good: 0, warn: 0, bad: 0 };
  for (const b of bids) counts[classifySignal(b.unit_price, low, high)]++;
  const summary =
    `Estimate ${formatUnitPrice(est)}, band ${formatUnitPrice(low)} to ${formatUnitPrice(high)}. ` +
    (bids.length
      ? `${bids.length} bids: ${counts.good} below band, ${counts.warn} in band, ${counts.bad} above band.`
      : "No bids yet.");

  // Draw the winner last so it sits on top.
  const ordered = [...bids].sort((a, b) => Number(a.bid_id === winnerBidId) - Number(b.bid_id === winnerBidId));

  return (
    <div>
      <div role="img" aria-label={summary} className="relative h-[84px] select-none">
        <span
          className="absolute top-0 -translate-x-1/2 whitespace-nowrap text-caption font-medium tabular-nums text-accent-text"
          style={{ left: `${estPct}%` }}
        >
          est. {formatUnitPrice(est)}
        </span>
        {/* track */}
        <div className="absolute inset-x-0 top-[30px] h-3 rounded-full bg-surface-2" />
        {/* band */}
        <div
          className="absolute top-[30px] h-3 rounded-full border border-accent/30 bg-accent-soft"
          style={{ left: `${lowPct}%`, width: `${Math.max(0, highPct - lowPct)}%` }}
        />
        {/* estimate tick */}
        <div
          className="absolute top-[24px] h-6 w-0.5 -translate-x-1/2 rounded-full bg-accent"
          style={{ left: `${estPct}%` }}
        />
        {ordered.map((b) => {
          const sig = classifySignal(b.unit_price, low, high);
          const winner = b.bid_id === winnerBidId;
          return (
            <span
              key={b.bid_id}
              title={`${b.supplier_name} ${formatUnitPrice(b.unit_price)} · ${formatSignedPct(
                deltaFraction(b.unit_price, est),
              )} ${SIGNAL_LABEL[sig]}${winner ? " · winner" : ""}`}
              className={`absolute top-[36px] -translate-x-1/2 -translate-y-1/2 rounded-full ${SIGNAL_BG[sig]} ${
                winner
                  ? "z-10 h-[18px] w-[18px] border-[3px] border-surface ring-2 ring-text"
                  : "h-3.5 w-3.5 border-2 border-surface shadow-[0_0_0_1px_rgb(var(--bs-border-strong))]"
              }`}
              style={{ left: `${toPct(b.unit_price, domain)}%` }}
            />
          );
        })}
        <span
          className="absolute top-[52px] -translate-x-1/2 text-caption tabular-nums text-text-2"
          style={{ left: `${lowPct}%` }}
        >
          {formatUnitPrice(low)}
        </span>
        <span
          className="absolute top-[52px] -translate-x-1/2 text-caption tabular-nums text-text-2"
          style={{ left: `${highPct}%` }}
        >
          {formatUnitPrice(high)}
        </span>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-2" aria-label="Legend">
        <li className="flex items-center gap-1.5">
          <Dot className="h-2.5 w-2.5 bg-good" /> Below band (under {formatUnitPrice(low)})
        </li>
        <li className="flex items-center gap-1.5">
          <Dot className="h-2.5 w-2.5 bg-warn" /> In band
        </li>
        <li className="flex items-center gap-1.5">
          <Dot className="h-2.5 w-2.5 bg-bad" /> Above band (over {formatUnitPrice(high)})
        </li>
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="h-3 w-0.5 rounded-full bg-accent" /> Estimate
        </li>
      </ul>
      {bids.length === 0 && (
        <p className="mt-3 text-caption text-text-2">Bids will be plotted here as they arrive.</p>
      )}
    </div>
  );
}
