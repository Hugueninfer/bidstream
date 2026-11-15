import { useId, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, isApiError } from "../api/client";
import type { Bid, Rfq } from "../api/types";
import { formatMoney, formatPct, formatQuantity, formatUnitPrice, shortId } from "../lib/format";
import { useModal } from "../lib/hooks";
import { savingsVsEstimate } from "../lib/pricing";

function Row({ label, children, strong = false }: { label: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className={`flex items-center justify-between gap-4 border-t py-2.5 ${strong ? "text-title-2" : ""}`}>
      <dt className={strong ? "font-semibold" : "text-text-2"}>{label}</dt>
      <dd className={`text-right tabular-nums ${strong ? "font-semibold" : ""}`}>{children}</dd>
    </div>
  );
}

function errorText(e: unknown): string {
  if (isApiError(e, "rfq_closed")) return "This RFQ is no longer open, so it can't be awarded. It may have just been awarded or expired.";
  if (isApiError(e, "not_found")) return "This bid or RFQ no longer exists.";
  if (isApiError(e)) return `${e.message} (${e.code})`;
  return "Couldn't award the bid. Try again.";
}

/** Irreversible award confirmation: supplier, price, total and savings vs estimate. */
export function AwardDialog({
  rfq,
  bid,
  onClose,
  onAwarded,
}: {
  rfq: Rfq;
  bid: Bid;
  onClose: () => void;
  onAwarded: (rfq: Rfq) => void;
}) {
  const titleId = useId();
  const descId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const award = useMutation({ mutationFn: () => api.award(rfq.rfq_id, { bid_id: bid.bid_id }), onSuccess: onAwarded });
  const close = () => {
    if (!award.isPending) onClose();
  };
  const ref = useModal<HTMLDivElement>(true, close, cancelRef);

  const total = bid.unit_price * rfq.quantity;
  const est = rfq.estimate;
  const savings = est ? savingsVsEstimate(bid.unit_price, rfq.quantity, est.estimated_unit_price) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[12vh]">
      <div className="fixed inset-0 bg-black/35" onClick={close} aria-hidden />
      <div
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className="relative w-full max-w-[500px] rounded-2xl border bg-surface p-5 shadow-2xl"
      >
        <h2 id={titleId} className="text-title-2">
          Award this bid?
        </h2>
        <p id={descId} className="mt-1 text-body text-text-2">
          This closes <span title={rfq.rfq_id}>{shortId(rfq.rfq_id)}</span>. Other suppliers are notified, and the RFQ
          becomes read-only. You can’t undo an award.
        </p>

        <dl className="mt-4">
          <Row label="Supplier">
            <span className="font-medium">{bid.supplier_name}</span>
          </Row>
          <Row label="Unit price">{formatUnitPrice(bid.unit_price)}</Row>
          <Row label="Quantity">
            {formatQuantity(rfq.quantity)} {rfq.unit}
          </Row>
          <Row label="Lead time">
            {bid.lead_time_days} {bid.lead_time_days === 1 ? "day" : "days"}
          </Row>
          <Row label="Total" strong>
            {formatMoney(total)}
          </Row>
        </dl>

        {est && savings && (
          <div
            className={`mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg px-4 py-3 text-body font-medium tabular-nums ${
              savings.amount >= 0 ? "bg-good-soft text-good" : "bg-bad-soft text-bad"
            }`}
          >
            <span>
              {savings.amount >= 0 ? "Savings" : "Over"} vs estimate ({formatUnitPrice(est.estimated_unit_price)} /{" "}
              {rfq.unit})
            </span>
            <span>
              {savings.amount >= 0 ? "" : "+"}
              {formatMoney(Math.abs(savings.amount))} · {formatPct(savings.fraction)}
            </span>
          </div>
        )}
        {!est && (
          <p className="mt-2 rounded-lg bg-surface-2 px-4 py-3 text-caption text-text-2">
            No price estimate available, so savings can’t be computed.
          </p>
        )}

        {award.isError && (
          <p role="alert" className="mt-3 rounded-lg border border-bad/30 bg-bad-soft px-4 py-3 text-body text-bad">
            {errorText(award.error)}
          </p>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <span className="font-mono text-mono-xs text-text-3">emits rfq.awarded → rfq.events</span>
          <div className="flex gap-2">
            <button ref={cancelRef} type="button" className="bs-btn-secondary" onClick={close} disabled={award.isPending}>
              Cancel
            </button>
            <button
              type="button"
              className="bs-btn-primary tabular-nums"
              onClick={() => award.mutate()}
              disabled={award.isPending || isApiError(award.error, "rfq_closed")}
            >
              {award.isPending ? "Awarding…" : `Award ${formatMoney(total)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
