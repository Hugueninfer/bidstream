import type { Bid, Rfq } from "../api/types";
import { formatClock, formatModel, formatMoney, formatQuantity, formatUnitPrice } from "../lib/format";
import { useNow } from "../lib/hooks";
import { AlertIcon } from "./Icons";
import { PriceBandChart } from "./PriceBandChart";
import { Skeleton } from "./ui";

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-caption text-text-2">{label}</dt>
      <dd className="mt-0.5 text-body tabular-nums text-text">{children}</dd>
    </div>
  );
}

function Header({ rfq }: { rfq: Rfq }) {
  const e = rfq.estimate;
  return (
    <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5">
      <h2 id="price-prediction" className="text-section">Price prediction</h2>
      {e && (
        <div className="flex gap-1.5">
          <span className="bs-chip">model {formatModel(e.model_version)}</span>
          <span className={`bs-chip ${e.cache_hit ? "bg-good-soft text-good" : ""}`}>
            {e.cache_hit ? "cache hit" : "cache miss"}
          </span>
        </div>
      )}
    </div>
  );
}

/** Estimate, band, expected total, sample size, model + latency, and the band chart with every bid. */
export function PricePredictionCard({
  rfq,
  bids,
  lastAttemptAt,
  retryEveryMs,
  onRetry,
  retrying,
}: {
  rfq: Rfq;
  bids: Bid[] | undefined;
  lastAttemptAt: number;
  retryEveryMs: number;
  onRetry: () => void;
  retrying: boolean;
}) {
  const e = rfq.estimate;

  if (!e) return <PricingUnavailable rfq={rfq} lastAttemptAt={lastAttemptAt} retryEveryMs={retryEveryMs} onRetry={onRetry} retrying={retrying} />;

  return (
    <section className="bs-card" aria-labelledby="price-prediction">
      <Header rfq={rfq} />
      <div className="grid gap-6 px-5 py-5 md:grid-cols-[minmax(240px,320px)_1fr] md:gap-10">
        <div>
          <p className="text-caption text-text-2">Estimated unit price</p>
          <p className="mt-1">
            <span className="text-display tabular-nums">{formatUnitPrice(e.estimated_unit_price)}</span>{" "}
            <span className="text-body text-text-2">/ {rfq.unit}</span>
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4">
            <Stat label="Band (low – high)">
              {formatUnitPrice(e.low)} – {formatUnitPrice(e.high)}
            </Stat>
            <Stat label="Expected total">{formatMoney(e.estimated_unit_price * rfq.quantity)}</Stat>
            <Stat label="Sample size">{formatQuantity(e.sample_size)} awards</Stat>
            <Stat label="Model">
              {formatModel(e.model_version)} · {Math.round(e.latency_ms)} ms
            </Stat>
          </dl>
        </div>
        <div className="md:pt-3">
          {bids ? (
            <PriceBandChart estimate={e} bids={bids} winnerBidId={rfq.awarded?.bid_id} />
          ) : (
            <Skeleton className="h-20 w-full" />
          )}
        </div>
      </div>
      <p className="break-words border-t px-5 py-3 font-mono text-mono-xs text-text-3">
        GET /v1/estimate?sku={encodeURIComponent(e.sku)}&amp;qty={e.quantity} · 200 · {Math.round(e.latency_ms)} ms ·
        cache_hit={String(e.cache_hit)} · sample_size={e.sample_size}
      </p>
    </section>
  );
}

function PricingUnavailable({
  rfq,
  lastAttemptAt,
  retryEveryMs,
  onRetry,
  retrying,
}: {
  rfq: Rfq;
  lastAttemptAt: number;
  retryEveryMs: number;
  onRetry: () => void;
  retrying: boolean;
}) {
  const now = useNow(1000);
  const retryIn = Math.max(0, Math.ceil((lastAttemptAt + retryEveryMs - now) / 1000));
  const err = rfq.estimate_error;
  return (
    <section className="bs-card" aria-labelledby="price-prediction">
      <Header rfq={rfq} />
      <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-start">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-warn-soft text-warn">
          <AlertIcon />
        </div>
        <div className="min-w-0 flex-1" role="status">
          <p className="text-section">Price prediction is unavailable right now</p>
          <p className="mt-1 max-w-[640px] text-body text-text-2">
            pricing-service isn’t responding, so there’s no estimate to compare against. Bids still arrive live and
            you can still award one. Deltas will fill in once the service recovers.
          </p>
          <p className="mt-2 break-words font-mono text-mono-xs text-text-3">
            GET /v1/estimate → {err ? `${err.code}: ${err.message}` : "no estimate returned"} · last attempt{" "}
            {formatClock(lastAttemptAt)} · {retrying ? "retrying…" : `auto-retry in ${retryIn} s`}
          </p>
        </div>
        <button type="button" className="bs-btn-secondary shrink-0" onClick={onRetry} disabled={retrying}>
          {retrying ? "Retrying…" : "Retry now"}
        </button>
      </div>
    </section>
  );
}
