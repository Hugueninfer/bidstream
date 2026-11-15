import { useState } from "react";
import type { Bid, Rfq } from "../api/types";
import { lowestBid, sortBids, type BidSortKey, type SortDir } from "../lib/bids";
import { formatAgo, formatClock, formatMoney, formatSignedPct, formatUnitPrice, shortId } from "../lib/format";
import { useNow } from "../lib/hooks";
import { priceSignal } from "../lib/pricing";
import { EmptyState } from "./EmptyState";
import { ActivityIcon, CheckIcon, SortIcon } from "./Icons";
import { SIGNAL_BG, SIGNAL_TEXT } from "../lib/signalStyles";
import { Dot, LivePill, Skeleton } from "./ui";

const COLUMNS: { key: BidSortKey; label: string; align: "left" | "right" }[] = [
  { key: "supplier", label: "Supplier", align: "left" },
  { key: "unit_price", label: "Unit price", align: "right" },
  { key: "delta", label: "Δ vs estimate", align: "right" },
  { key: "total", label: "Total", align: "right" },
  { key: "lead_time", label: "Lead time", align: "right" },
  { key: "submitted", label: "Submitted", align: "right" },
];

const DEFAULT_DIR: Record<BidSortKey, SortDir> = {
  supplier: "asc",
  unit_price: "asc",
  delta: "asc",
  total: "asc",
  lead_time: "asc",
  submitted: "desc",
};

function DeltaCell({ bid, rfq }: { bid: Bid; rfq: Rfq }) {
  const s = priceSignal(bid.unit_price, rfq.estimate);
  if (!s) {
    return (
      <>
        <div className="text-text-3">—</div>
        <div className="text-caption text-text-3">no estimate</div>
      </>
    );
  }
  return (
    <>
      <div className={`inline-flex items-center gap-1.5 font-medium ${SIGNAL_TEXT[s.signal]}`}>
        <Dot className={SIGNAL_BG[s.signal]} />
        {formatSignedPct(s.delta)}
      </div>
      <div className="text-caption text-text-2">{s.label}</div>
    </>
  );
}

/** Live bids for one RFQ: sortable columns, lowest-bid summary, Award buttons while open, winner row after award. */
export function BidsTable({
  rfq,
  bids,
  loading,
  live,
  flashIds,
  onAward,
}: {
  rfq: Rfq;
  bids: Bid[] | undefined;
  loading: boolean;
  live: boolean;
  flashIds: ReadonlySet<string>;
  onAward: (bid: Bid) => void;
}) {
  const [sort, setSort] = useState<{ key: BidSortKey; dir: SortDir }>({ key: "submitted", dir: "desc" });
  const now = useNow(1000);
  const open = rfq.status === "open";
  const winnerId = rfq.awarded?.bid_id ?? null;
  const list = bids ?? [];
  const sorted = sortBids(list, sort.key, sort.dir);
  const lowest = lowestBid(list);
  const lowestSig = lowest ? priceSignal(lowest.unit_price, rfq.estimate) : null;

  const toggleSort = (key: BidSortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: DEFAULT_DIR[key] }));

  return (
    <section className="bs-card" aria-labelledby="bids-heading">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-5 py-3.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 id="bids-heading" className="text-section">
            Bids <span className="font-normal tabular-nums text-text-2">{bids ? list.length : ""}</span>
          </h2>
          {bids &&
            (open ? (
              <>
                <LivePill live={live} />
                <span className="font-mono text-mono-xs text-text-3">streaming bid.events</span>
              </>
            ) : (
              <span className="rounded-full bg-surface-2 px-2 py-0.5 text-caption font-medium text-text-2">Closed</span>
            ))}
        </div>
        {lowest && (
          <p className="text-caption tabular-nums text-text-2">
            Lowest: <span className="font-medium text-text">{lowest.supplier_name}</span> ·{" "}
            {formatUnitPrice(lowest.unit_price)}
            {lowestSig && <span className={SIGNAL_TEXT[lowestSig.signal]}> {formatSignedPct(lowestSig.delta)}</span>}
          </p>
        )}
      </div>

      {loading ? (
        <div aria-busy="true" aria-label="Loading bids">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex gap-6 border-b px-5 py-4 last:border-b-0">
              <Skeleton className="h-3 flex-[2]" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-3 flex-1" />
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<ActivityIcon />}
          title={open ? "No bids yet" : "No bids"}
          footer={
            open && (
              <span className="inline-flex items-center gap-1.5 font-mono text-mono-xs text-text-3">
                <Dot className={`h-1.5 w-1.5 ${live ? "bg-good" : "bg-warn"}`} />
                {live ? "subscribed to" : "reconnecting to"} bid.events · key {shortId(rfq.rfq_id)}
              </span>
            )
          }
        >
          {open
            ? "Suppliers can see this RFQ now. Each bid appears here the moment it’s submitted, no refresh needed."
            : "This RFQ closed without any bids."}
        </EmptyState>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-body">
            <caption className="sr-only">
              Bids, sorted by {COLUMNS.find((c) => c.key === sort.key)?.label} {sort.dir === "asc" ? "ascending" : "descending"}
            </caption>
            <thead className="border-b">
              <tr>
                {COLUMNS.map((c) => {
                  const active = sort.key === c.key;
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                      className={`px-4 py-2.5 text-caption font-medium first:pl-5 ${
                        c.align === "right" ? "text-right" : "text-left"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className={`inline-flex items-center gap-1 rounded-sm ${active ? "text-text" : "text-text-2 hover:text-text"}`}
                      >
                        {c.label}
                        <SortIcon dir={active ? sort.dir : null} className={active ? "" : "text-text-3"} />
                      </button>
                    </th>
                  );
                })}
                <th scope="col" className="px-4 py-2.5 pr-5">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((b) => {
                const winner = b.bid_id === winnerId;
                return (
                  <tr
                    key={b.bid_id}
                    className={`border-b last:border-b-0 ${winner ? "bg-good-soft" : ""} ${
                      flashIds.has(b.bid_id) ? "motion-safe:animate-flash" : ""
                    }`}
                  >
                    <td className="px-4 py-3 pl-5">
                      <div className="font-medium">{b.supplier_name}</div>
                      <div className="font-mono text-mono-xs text-text-3">
                        <span title={b.bid_id}>{shortId(b.bid_id)}</span> · {b.supplier_id}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums">{formatUnitPrice(b.unit_price)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <DeltaCell bid={b} rfq={rfq} />
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{formatMoney(b.unit_price * rfq.quantity)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                      {b.lead_time_days} {b.lead_time_days === 1 ? "day" : "days"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular-nums">
                      <time dateTime={b.submitted_at}>{formatClock(b.submitted_at)}</time>
                      <div className="text-caption text-text-3">{formatAgo(b.submitted_at, now)}</div>
                    </td>
                    <td className="px-4 py-3 pr-5 text-right">
                      {winner ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-good px-2.5 py-1 text-caption font-medium text-white">
                          <CheckIcon width={12} height={12} /> Winner
                        </span>
                      ) : open ? (
                        <button
                          type="button"
                          className="bs-btn-secondary bs-btn-sm"
                          onClick={() => onAward(b)}
                          aria-label={`Award bid from ${b.supplier_name} at ${formatUnitPrice(b.unit_price)}`}
                        >
                          Award
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
