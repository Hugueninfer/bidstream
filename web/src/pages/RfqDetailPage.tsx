import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { isApiError, TENANT_ID } from "../api/client";
import { PRICING_RETRY_MS, qk, useBids, useRfq } from "../api/queries";
import type { Bid, BidsResponse, Rfq } from "../api/types";
import { AwardDialog } from "../components/AwardDialog";
import { BidsTable } from "../components/BidsTable";
import { EmptyState } from "../components/EmptyState";
import { ErrorCard } from "../components/ErrorCard";
import { CheckIcon, FilePlusIcon } from "../components/Icons";
import { PricePredictionCard } from "../components/PricePredictionCard";
import { StatusBadge } from "../components/StatusBadge";
import { Skeleton } from "../components/ui";
import {
  formatClock,
  formatCountdown,
  formatDateTime,
  formatDeadlineRelative,
  formatMoney,
  formatPct,
  formatQuantity,
  formatUnitPrice,
  shortId,
} from "../lib/format";
import { useNow } from "../lib/hooks";
import { savingsVsEstimate } from "../lib/pricing";
import { useLive, useLiveEvent } from "../live/LiveEvents";

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-caption text-text-2">{label}</dt>
      <dd className="mt-1 text-body tabular-nums">{children}</dd>
    </div>
  );
}

function Countdown({ deadline }: { deadline: string }) {
  const now = useNow(1000);
  const ms = Date.parse(deadline) - now;
  return (
    <span className="font-semibold tabular-nums" role="timer" aria-live="off">
      {ms > 0 ? formatCountdown(ms) : "Closing…"}
    </span>
  );
}

function Breadcrumb({ rfqId }: { rfqId: string }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4 text-body text-text-2">
      <Link to="/" className="hover:text-text hover:underline">
        RFQs
      </Link>
      <span className="mx-1.5" aria-hidden>
        /
      </span>
      <span className="font-mono text-mono text-text" title={rfqId} aria-current="page">
        {shortId(rfqId)}
      </span>
    </nav>
  );
}

function RfqHeader({ rfq }: { rfq: Rfq }) {
  const now = useNow(60_000);
  return (
    <header className="mb-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-title-1">{rfq.title}</h1>
        <StatusBadge status={rfq.status} />
      </div>
      <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-4">
        <Meta label="SKU">
          <span className="bs-chip">{rfq.sku}</span>
        </Meta>
        <Meta label="Quantity">
          <span className="font-semibold">{formatQuantity(rfq.quantity)}</span> <span className="text-text-2">{rfq.unit}</span>
        </Meta>
        {rfq.status === "open" ? (
          <Meta label="Closes in">
            <Countdown deadline={rfq.deadline} />{" "}
            <span className="ml-1 text-caption text-text-3">{formatDateTime(rfq.deadline)}</span>
          </Meta>
        ) : rfq.awarded ? (
          <Meta label="Awarded">
            <span className="font-semibold">{formatDateTime(rfq.awarded.awarded_at)}</span>{" "}
            <span className="ml-1 text-caption text-text-3">deadline was {formatDateTime(rfq.deadline)}</span>
          </Meta>
        ) : (
          <Meta label="Closed">
            <span className="font-semibold">{formatDateTime(rfq.deadline)}</span>{" "}
            <span className="ml-1 text-caption text-text-3">{formatDeadlineRelative(rfq.deadline, now)}</span>
          </Meta>
        )}
        <Meta label="Created">{formatDateTime(rfq.created_at)}</Meta>
        <Meta label="rfq_id">
          <span className="font-mono text-mono text-text-2" title={rfq.rfq_id}>
            {shortId(rfq.rfq_id)} · {rfq.tenant_id || TENANT_ID}
          </span>
        </Meta>
      </dl>
    </header>
  );
}

function AwardedCallout({ rfq }: { rfq: Rfq }) {
  const a = rfq.awarded!;
  const total = a.unit_price * rfq.quantity;
  const s = rfq.estimate ? savingsVsEstimate(a.unit_price, rfq.quantity, rfq.estimate.estimated_unit_price) : null;
  return (
    <div role="status" className="mb-5 flex gap-3 rounded-xl border border-good/30 bg-good-soft px-5 py-4">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-good text-white">
        <CheckIcon />
      </span>
      <div className="min-w-0">
        <p className="text-section">Awarded to {a.supplier_name}</p>
        <p className="mt-0.5 text-body tabular-nums text-text-2">
          {formatUnitPrice(a.unit_price)} × {formatQuantity(rfq.quantity)} {rfq.unit} ={" "}
          <span className="font-semibold text-text">{formatMoney(total)}</span>
          {s &&
            (s.amount >= 0
              ? ` · saves ${formatMoney(s.amount)} (${formatPct(s.fraction)}) vs predicted`
              : ` · ${formatMoney(-s.amount)} (${formatPct(s.fraction)}) above predicted`)}
        </p>
        <p className="mt-1 text-caption text-text-2">
          This RFQ is now read-only. Every supplier was notified via rfq.awarded at {formatClock(a.awarded_at)}.
        </p>
      </div>
    </div>
  );
}

function DetailSkeleton({ rfqId }: { rfqId: string }) {
  return (
    <div aria-busy="true" aria-label="Loading RFQ">
      <Breadcrumb rfqId={rfqId} />
      <Skeleton className="mb-3 h-7 w-[440px] max-w-full" />
      <div className="mb-6 flex gap-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-48" />
      </div>
      <div className="bs-card mb-5">
        <div className="border-b px-5 py-3.5 text-section">Price prediction</div>
        <div className="flex gap-10 px-5 py-5">
          <div className="w-[300px] space-y-3">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-8 w-24" />
            <Skeleton className="h-3 w-48" />
          </div>
          <div className="flex-1 space-y-3 pt-6">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </div>
      </div>
      <div className="bs-card">
        <div className="border-b px-5 py-3.5 text-section">Bids</div>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex gap-6 border-b px-5 py-4 last:border-b-0">
            <Skeleton className="h-3 flex-[2]" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 flex-1" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function RfqDetailPage() {
  const { rfqId = "" } = useParams();
  const rfqQ = useRfq(rfqId);
  const bidsQ = useBids(rfqId);
  const queryClient = useQueryClient();
  const live = useLive();
  const [flashIds, setFlashIds] = useState<ReadonlySet<string>>(() => new Set());
  const [awarding, setAwarding] = useState<Bid | null>(null);

  useEffect(() => {
    setFlashIds(new Set());
    setAwarding(null);
  }, [rfqId]);

  useLiveEvent((ev) => {
    if (ev.key !== rfqId || ev.event_type !== "bid.submitted") return;
    const bidId = typeof ev.data.bid_id === "string" ? ev.data.bid_id : null;
    const current = queryClient.getQueryData<BidsResponse>(qk.bids(rfqId));
    // Only flash bids we haven't shown yet (the stream replays recent events on (re)connect).
    if (bidId && current && !current.bids.some((b) => b.bid_id === bidId)) {
      setFlashIds((prev) => new Set(prev).add(bidId));
    }
    void queryClient.invalidateQueries({ queryKey: qk.bids(rfqId) });
  });

  if (rfqQ.isPending) return <DetailSkeleton rfqId={rfqId} />;
  if (rfqQ.isError) {
    return (
      <div className="mx-auto max-w-[1080px]">
        <Breadcrumb rfqId={rfqId} />
        {isApiError(rfqQ.error, "not_found") ? (
          <EmptyState
            bordered
            icon={<FilePlusIcon />}
            title="RFQ not found"
            action={
              <Link to="/" className="bs-btn-secondary">
                Back to RFQs
              </Link>
            }
          >
            There’s no RFQ <span className="font-mono">{rfqId}</span> in {TENANT_ID}.
          </EmptyState>
        ) : (
          <ErrorCard what="this RFQ" error={rfqQ.error} onRetry={() => void rfqQ.refetch()} />
        )}
      </div>
    );
  }

  const rfq = rfqQ.data;

  return (
    <div className="mx-auto max-w-[1080px]">
      <Breadcrumb rfqId={rfq.rfq_id} />
      <RfqHeader rfq={rfq} />
      {rfq.status === "awarded" && rfq.awarded && <AwardedCallout rfq={rfq} />}

      <div className="space-y-5">
        <PricePredictionCard
          rfq={rfq}
          bids={bidsQ.data?.bids}
          lastAttemptAt={rfqQ.dataUpdatedAt}
          retryEveryMs={PRICING_RETRY_MS}
          onRetry={() => void rfqQ.refetch()}
          retrying={rfqQ.isFetching}
        />
        {bidsQ.isError ? (
          <ErrorCard what="bids" error={bidsQ.error} onRetry={() => void bidsQ.refetch()} />
        ) : (
          <BidsTable
            rfq={rfq}
            bids={bidsQ.data?.bids}
            loading={bidsQ.isPending}
            live={live.status === "live"}
            flashIds={flashIds}
            onAward={setAwarding}
          />
        )}
      </div>

      {awarding && (
        <AwardDialog
          rfq={rfq}
          bid={awarding}
          onClose={() => setAwarding(null)}
          onAwarded={(updated) => {
            queryClient.setQueryData(qk.rfq(updated.rfq_id), updated);
            void queryClient.invalidateQueries({ queryKey: qk.rfqsAll });
            void queryClient.invalidateQueries({ queryKey: qk.bids(updated.rfq_id) });
            setAwarding(null);
          }}
        />
      )}
    </div>
  );
}
