import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useRfqs } from "../api/queries";
import type { Rfq } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { ErrorCard } from "../components/ErrorCard";
import { ClockIcon, FilePlusIcon } from "../components/Icons";
import { SupplierBidForm } from "../components/SupplierBidForm";
import { Skeleton } from "../components/ui";
import { formatDistance, formatQuantity, isClosingSoon, shortId } from "../lib/format";
import { useNow } from "../lib/hooks";

const NEW_WINDOW_MS = 60 * 60 * 1000;
const closedAt = (r: Rfq) => Date.parse(r.awarded?.awarded_at ?? r.deadline);

function OpenCard({ rfq, selected, now, onSelect }: { rfq: Rfq; selected: boolean; now: number; onSelect: () => void }) {
  const ms = Date.parse(rfq.deadline) - now;
  const soon = isClosingSoon(rfq.deadline, now);
  const isNew = now - Date.parse(rfq.created_at) < NEW_WINDOW_MS;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-full flex-col rounded-xl border bg-surface p-4 text-left transition-shadow hover:border-border-strong ${
        selected ? "border-accent ring-[3px] ring-accent/20 hover:border-accent" : ""
      }`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="font-semibold">{rfq.title}</span>
        {isNew && (
          <span className="shrink-0 rounded-sm bg-accent-soft px-1.5 py-0.5 text-caption font-medium text-accent-text">
            New
          </span>
        )}
      </span>
      <span className="mt-2.5 flex items-center gap-2">
        <span className="bs-chip">{rfq.sku}</span>
        <span className="tabular-nums">
          {formatQuantity(rfq.quantity)} <span className="text-text-3">{rfq.unit}</span>
        </span>
      </span>
      <span className="min-h-[14px] flex-1" aria-hidden />
      <span className="flex items-center justify-between gap-2 border-t pt-3 text-caption">
        <span className={`flex items-center gap-1.5 ${soon ? "text-warn" : "text-text-2"}`}>
          <ClockIcon width={14} height={14} />
          {ms > 0 ? `Closes in ${formatDistance(ms)}` : "Closing now"}
        </span>
        <span className="font-mono text-mono text-text-3" title={rfq.rfq_id}>
          {shortId(rfq.rfq_id)}
        </span>
      </span>
    </button>
  );
}

function ClosedCard({ rfq, selected, now, onSelect }: { rfq: Rfq; selected: boolean; now: number; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`flex w-full flex-col rounded-xl border bg-surface-2 p-4 text-left ${
        selected ? "border-accent ring-[3px] ring-accent/20" : "hover:border-border-strong"
      }`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="text-text-2">{rfq.title}</span>
        <span
          className={`shrink-0 rounded-sm px-1.5 py-0.5 text-caption font-medium ${
            rfq.status === "awarded" ? "bg-good-soft text-good" : "bg-surface text-text-2"
          }`}
        >
          {rfq.status === "awarded" ? "Awarded" : "Expired"}
        </span>
      </span>
      <span className="mt-2 flex items-center justify-between gap-2 text-caption text-text-3">
        <span>Closed {formatDistance(now - closedAt(rfq))} ago</span>
        <span className="font-mono text-mono" title={rfq.rfq_id}>
          {shortId(rfq.rfq_id)}
        </span>
      </span>
    </button>
  );
}

export function SupplierPage() {
  const q = useRfqs();
  const now = useNow(30_000);
  const [params, setParams] = useSearchParams();
  const [nonce, setNonce] = useState(0);

  const { open, closed } = useMemo(() => {
    const rfqs = q.data?.rfqs ?? [];
    return {
      open: rfqs.filter((r) => r.status === "open"),
      closed: rfqs
        .filter((r) => r.status !== "open")
        .sort((a, b) => closedAt(b) - closedAt(a))
        .slice(0, 4),
    };
  }, [q.data]);

  const all = [...open, ...closed];
  const selectedId = params.get("rfq");
  const selected = all.find((r) => r.rfq_id === selectedId) ?? open[0] ?? null;

  const select = (id: string) => {
    const next = new URLSearchParams(params);
    next.set("rfq", id);
    setParams(next, { replace: true });
  };

  const another = () => {
    const idx = open.findIndex((r) => r.rfq_id === selected?.rfq_id);
    const next = open[(idx + 1) % Math.max(open.length, 1)];
    if (next) select(next.rfq_id);
    setNonce((n) => n + 1);
  };

  return (
    <div className="mx-auto max-w-[1080px]">
      <h1 className="text-title-1">Open RFQs</h1>
      <p className="mt-1 text-body text-text-2">
        Pick a request and submit your unit price. The buyer sees your bid the moment bid-service accepts it.
      </p>

      <div className="mt-5">
        {q.isPending ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3" aria-busy="true">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="bs-card space-y-3 p-4">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-3 w-full" />
              </div>
            ))}
          </div>
        ) : q.isError ? (
          <ErrorCard what="RFQs" error={q.error} onRetry={() => void q.refetch()} />
        ) : all.length === 0 ? (
          <EmptyState bordered icon={<FilePlusIcon />} title="No RFQs to bid on yet">
            When a buyer creates an RFQ it shows up here straight away (rfq.created → rfq.events).
          </EmptyState>
        ) : (
          <div className="flex flex-wrap items-start gap-5">
            <div className="min-w-0 flex-[1_1_560px]">
              {open.length === 0 ? (
                <div className="bs-card px-5 py-8 text-center text-body text-text-2">No open RFQs right now.</div>
              ) : (
                <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3" aria-label="Open RFQs">
                  {open.map((r) => (
                    <li key={r.rfq_id} className="flex">
                      <OpenCard
                        rfq={r}
                        now={now}
                        selected={r.rfq_id === selected?.rfq_id}
                        onSelect={() => select(r.rfq_id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
              {closed.length > 0 && (
                <>
                  <h2 className="mb-3 mt-8 text-section text-text-2">Recently closed</h2>
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3" aria-label="Recently closed RFQs">
                    {closed.map((r) => (
                      <li key={r.rfq_id} className="flex">
                        <ClosedCard
                          rfq={r}
                          now={now}
                          selected={r.rfq_id === selected?.rfq_id}
                          onSelect={() => select(r.rfq_id)}
                        />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            <div className="min-w-0 flex-[1_1_380px] shell:sticky shell:top-[80px]">
              {selected ? (
                <SupplierBidForm key={`${selected.rfq_id}:${nonce}`} rfq={selected} onAnother={another} />
              ) : (
                <div className="bs-card px-5 py-8 text-center text-body text-text-2">Select an RFQ to bid on.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
