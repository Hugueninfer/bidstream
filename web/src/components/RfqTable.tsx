import { Link, useNavigate } from "react-router-dom";
import type { Rfq } from "../api/types";
import {
  formatDateTime,
  formatDeadlineRelative,
  formatQuantity,
  formatUnitPrice,
  isClosingSoon,
  shortId,
} from "../lib/format";
import { useNow } from "../lib/hooks";
import { priceSignal } from "../lib/pricing";
import { PricePill } from "./PricePill";
import { StatusBadge } from "./StatusBadge";
import { Skeleton } from "./ui";

const TH = "px-4 py-3 text-left text-caption font-medium text-text-2 whitespace-nowrap";

function BestVsPredicted({ rfq }: { rfq: Rfq }) {
  const price = rfq.awarded?.unit_price ?? rfq.best_bid?.unit_price ?? null;
  const est = rfq.estimate;
  if (price === null) {
    return (
      <div>
        <div className="text-text-2">—</div>
        <div className="text-caption text-text-3">
          {est ? `est. ${formatUnitPrice(est.estimated_unit_price)}` : "no estimate"}
        </div>
      </div>
    );
  }
  const sig = priceSignal(price, est);
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="whitespace-nowrap">
        <span className="font-semibold">{formatUnitPrice(price)}</span>
        {est && <span className="text-text-3"> / {formatUnitPrice(est.estimated_unit_price)}</span>}
      </div>
      {sig ? <PricePill s={sig} /> : <span className="text-caption text-text-3">no estimate</span>}
    </div>
  );
}

export function RfqTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="bs-card overflow-hidden" aria-busy="true" aria-label="Loading RFQs">
      <div className="h-11 border-b bg-surface-2" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-6 border-b px-4 py-5 last:border-b-0">
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="h-3 w-1/6" />
          <Skeleton className="h-3 w-1/6" />
          <Skeleton className="h-3 flex-1" />
        </div>
      ))}
    </div>
  );
}

/** RFQ list: status, deadline, bids and "best bid vs predicted" pill. Horizontally scrolls on small screens. */
export function RfqTable({ rfqs }: { rfqs: Rfq[] }) {
  const now = useNow(30_000);
  const navigate = useNavigate();

  return (
    <div className="bs-card relative overflow-x-auto">
      <table className="w-full min-w-[960px] border-collapse text-body">
        <caption className="sr-only">Requests for quote</caption>
        <thead className="border-b bg-surface-2">
          <tr>
            <th scope="col" className={TH}>RFQ</th>
            <th scope="col" className={TH}>SKU</th>
            <th scope="col" className={`${TH} text-right`}>Quantity</th>
            <th scope="col" className={TH}>Deadline</th>
            <th scope="col" className={TH}>Status</th>
            <th scope="col" className={`${TH} text-right`}>Bids</th>
            <th scope="col" className={`${TH} text-right`}>Best bid vs predicted</th>
          </tr>
        </thead>
        <tbody>
          {rfqs.map((r) => {
            const open = r.status === "open";
            const soon = open && isClosingSoon(r.deadline, now);
            return (
              <tr
                key={r.rfq_id}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest("a,button")) return;
                  navigate(`/rfqs/${r.rfq_id}`);
                }}
                className="cursor-pointer border-b align-top last:border-b-0 hover:bg-surface-2/60"
              >
                <td className="max-w-[300px] px-4 py-3.5">
                  <Link to={`/rfqs/${r.rfq_id}`} className="font-medium text-text hover:underline">
                    {r.title}
                  </Link>
                  <div className="font-mono text-mono text-text-3" title={r.rfq_id}>
                    {shortId(r.rfq_id)}
                  </div>
                </td>
                <td className="px-4 py-3.5">
                  <span className="bs-chip">{r.sku}</span>
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 text-right tabular-nums">
                  {formatQuantity(r.quantity)} <span className="text-text-3">{r.unit}</span>
                </td>
                <td className="whitespace-nowrap px-4 py-3.5">
                  <div className={open ? (soon ? "text-warn" : "text-text") : "text-text-3"}>
                    {formatDeadlineRelative(r.deadline, now)}
                  </div>
                  <div className="text-caption tabular-nums text-text-3">{formatDateTime(r.deadline)}</div>
                </td>
                <td className="px-4 py-3.5">
                  <StatusBadge status={r.status} />
                </td>
                <td className="px-4 py-3.5 text-right tabular-nums">{r.bid_count}</td>
                <td className="px-4 py-3.5 text-right tabular-nums">
                  <BestVsPredicted rfq={r} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
