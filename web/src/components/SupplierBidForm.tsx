import { useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, newIdempotencyKey } from "../api/client";
import { qk } from "../api/queries";
import type { Bid, Rfq } from "../api/types";
import {
  formatClock,
  formatDay,
  formatDistance,
  formatMoney,
  formatQuantity,
  formatUnitPrice,
  shortId,
} from "../lib/format";
import { useNow } from "../lib/hooks";
import { readStorage, writeStorage } from "../lib/storage";
import { validateBid } from "../lib/validation";
import { CheckIcon, LockIcon, RefreshIcon } from "./Icons";

const NAME_KEY = "bs-supplier-name";

type Result =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success"; bid: Bid; status: number }
  | { kind: "error"; error: ApiError };

function Callout({
  tone,
  icon,
  title,
  children,
  code,
}: {
  tone: "good" | "warn" | "bad" | "neutral";
  icon?: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  code?: string;
}) {
  const cls = {
    good: "border-good/30 bg-good-soft",
    warn: "border-warn/40 bg-warn-soft",
    bad: "border-bad/30 bg-bad-soft",
    neutral: "bg-surface-2",
  }[tone];
  const titleCls = { good: "text-good", warn: "text-warn", bad: "text-bad", neutral: "text-text" }[tone];
  return (
    <div role={tone === "good" ? "status" : "alert"} className={`flex gap-3 rounded-lg border px-4 py-3.5 ${cls}`}>
      {icon && <span className={`mt-0.5 shrink-0 ${titleCls}`}>{icon}</span>}
      <div className="min-w-0">
        <p className={`text-body font-semibold ${titleCls}`}>{title}</p>
        {children && <div className="mt-0.5 text-body text-text-2">{children}</div>}
        {code && <p className="mt-1.5 break-words font-mono text-mono-xs text-text-3">{code}</p>}
      </div>
    </div>
  );
}

function SummaryRow({ label, children, strong }: { label: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-4 border-t py-2.5">
      <dt className={strong ? "font-semibold" : "text-text-2"}>{label}</dt>
      <dd className={`text-right tabular-nums ${strong ? "font-semibold" : ""}`}>{children}</dd>
    </div>
  );
}

/**
 * Supplier bid form. One Idempotency-Key per logical submission, reused on every retry
 * (network error, 5xx, 409 rfq_syncing) until it succeeds or the payload changes.
 */
export function SupplierBidForm({ rfq, onAnother }: { rfq: Rfq; onAnother: () => void }) {
  const ids = { name: useId(), price: useId(), lead: useId(), summary: useId() };
  const now = useNow(30_000);
  const queryClient = useQueryClient();
  const [name, setName] = useState(() => readStorage(NAME_KEY) ?? "");
  const [price, setPrice] = useState("");
  const [lead, setLead] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const idem = useRef<{ key: string; payload: string } | null>(null);

  const closedByServer = result.kind === "error" && result.error.code === "rfq_closed";
  const closed = rfq.status !== "open" || closedByServer;
  const errors = attempted ? validateBid(name, price, lead) : {};
  const errorCount = Object.keys(errors).length;
  const p = Number(price);
  const priceOk = price.trim() !== "" && Number.isFinite(p) && p > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (closed || result.kind === "submitting") return;
    setAttempted(true);
    if (Object.keys(validateBid(name, price, lead)).length > 0) return;

    const body = { supplier_name: name.trim(), unit_price: Number(price), lead_time_days: Number(lead) };
    const payload = JSON.stringify([rfq.rfq_id, body]);
    if (!idem.current || idem.current.payload !== payload) idem.current = { key: newIdempotencyKey(), payload };

    writeStorage(NAME_KEY, body.supplier_name);
    setResult({ kind: "submitting" });
    try {
      const res = await api.submitBid(rfq.rfq_id, body, idem.current.key);
      idem.current = null;
      setResult({ kind: "success", bid: res.data, status: res.status });
      void queryClient.invalidateQueries({ queryKey: qk.bids(rfq.rfq_id) });
      void queryClient.invalidateQueries({ queryKey: qk.rfqsAll });
    } catch (err) {
      const error = err instanceof ApiError ? err : new ApiError(0, "network_error", String(err));
      setResult({ kind: "error", error });
      if (error.code === "rfq_closed") void queryClient.invalidateQueries({ queryKey: qk.rfqsAll });
    }
  };

  const deadlineMs = Date.parse(rfq.deadline) - now;
  const closedAt = rfq.awarded?.awarded_at ?? rfq.deadline;
  const metaWhen =
    rfq.status === "open"
      ? deadlineMs > 0
        ? `Closes in ${formatDistance(deadlineMs)}`
        : "Closing now"
      : `Closed ${formatDistance(now - Date.parse(closedAt))} ago`;

  const header = (
    <div className="border-b px-5 py-4">
      <h2 className="text-title-2">Submit a bid</h2>
      <p className="mt-1 text-body font-medium">{rfq.title}</p>
      <p className="mt-1 text-caption text-text-2">
        <span className="font-mono" title={rfq.rfq_id}>
          {shortId(rfq.rfq_id)}
        </span>
        <span className="mx-1.5 text-text-3">·</span>
        <span className="font-mono">{rfq.sku}</span>
        <span className="mx-1.5 text-text-3">·</span>
        <span className="tabular-nums">
          {formatQuantity(rfq.quantity)} {rfq.unit}
        </span>
        <span className="mx-1.5 text-text-3">·</span>
        {metaWhen}
      </p>
    </div>
  );

  if (result.kind === "success") {
    const b = result.bid;
    return (
      <section className="bs-card" aria-label="Submit a bid">
        {header}
        <div className="px-5 py-5">
          <Callout
            tone="good"
            icon={
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-good text-white">
                <CheckIcon width={14} height={14} />
              </span>
            }
            title={result.status === 200 ? "Bid already submitted" : "Bid submitted"}
          >
            {result.status === 200
              ? "This was a safe retry of a bid that had already gone through, so nothing was duplicated."
              : "The buyer can see it now. You’ll be notified if it’s awarded."}
          </Callout>
          <dl className="mt-4">
            <SummaryRow label="Supplier">{b.supplier_name}</SummaryRow>
            <SummaryRow label="Unit price">{formatUnitPrice(b.unit_price)}</SummaryRow>
            <SummaryRow label="Lead time">
              {b.lead_time_days} {b.lead_time_days === 1 ? "day" : "days"}
            </SummaryRow>
            <SummaryRow label="Total" strong>
              {formatMoney(b.unit_price * rfq.quantity)}
            </SummaryRow>
          </dl>
          <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2.5 font-mono text-mono-xs text-text-2">
            {result.status} {result.status === 201 ? "Created" : "OK (idempotent replay)"} ·{" "}
            <span title={b.bid_id}>{shortId(b.bid_id)}</span>
            <br />
            bid.submitted → bid.events · key {shortId(b.rfq_id)} · {formatClock(b.submitted_at)}
          </p>
          <button type="button" className="bs-btn-secondary mt-4 w-full" onClick={onAnother}>
            Bid on another RFQ
          </button>
        </div>
      </section>
    );
  }

  const err = result.kind === "error" ? result.error : null;
  const submitting = result.kind === "submitting";
  const syncing = err?.code === "rfq_syncing";

  return (
    <section className="bs-card" aria-label="Submit a bid">
      {header}
      <form onSubmit={submit} noValidate className="space-y-4 px-5 py-5" aria-describedby={ids.summary}>
        <div id={ids.summary} aria-live="polite">
          {closed ? (
            <Callout
              tone="neutral"
              icon={<LockIcon />}
              title="This RFQ is closed"
              code={
                closedByServer
                  ? `409 RFQ_CLOSED · ${err!.message}`
                  : `status=${rfq.status}`
              }
            >
              {rfq.status === "awarded" && rfq.awarded
                ? `The buyer awarded it on ${formatDay(rfq.awarded.awarded_at)}. New bids aren’t accepted.`
                : rfq.status === "expired"
                  ? `Bidding ended on ${formatDay(rfq.deadline)}. New bids aren’t accepted.`
                  : "It closed before your bid arrived. New bids aren’t accepted."}
            </Callout>
          ) : attempted && errorCount > 0 ? (
            <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft px-4 py-3 text-body font-medium text-bad">
              Fix {errorCount} {errorCount === 1 ? "field" : "fields"} to submit your bid.
            </div>
          ) : syncing ? (
            <Callout
              tone="warn"
              icon={<RefreshIcon />}
              title="This RFQ is still syncing. Try again in a few seconds."
              code={`409 ${err!.code.toUpperCase()} · ${err!.message}`}
            >
              It was just created, and bid-service hasn’t received it yet. Usually this takes under 5 seconds. Your bid
              wasn’t sent, and nothing you entered is lost.
            </Callout>
          ) : err?.code === "validation_error" ? (
            <Callout tone="bad" title="The server rejected this bid." code={`400 VALIDATION_ERROR`}>
              {err.message}
            </Callout>
          ) : err ? (
            <Callout
              tone="bad"
              title="Your bid didn’t go through."
              code={`${err.status || "network"} ${err.code.toUpperCase()} · ${err.message}`}
            >
              Nothing you entered is lost. Retrying is safe: it reuses the same Idempotency-Key, so the bid can’t be
              recorded twice.
            </Callout>
          ) : null}
        </div>

        <div>
          <label htmlFor={ids.name} className="mb-1.5 block text-label">
            Supplier name
          </label>
          <input
            id={ids.name}
            className="bs-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your company name"
            autoComplete="organization"
            maxLength={120}
            disabled={closed}
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? `${ids.name}-err` : undefined}
          />
          {errors.name && (
            <p id={`${ids.name}-err`} className="mt-1 text-caption text-bad">
              {errors.name}
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={ids.price} className="mb-1.5 block text-label">
              Unit price (USD)
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3" aria-hidden>
                $
              </span>
              <input
                id={ids.price}
                className="bs-input pl-7 text-right tabular-nums"
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value.replace(",", "."))}
                placeholder="0.00"
                disabled={closed}
                aria-invalid={!!errors.price}
                aria-describedby={errors.price ? `${ids.price}-err` : undefined}
              />
            </div>
            {errors.price && (
              <p id={`${ids.price}-err`} className="mt-1 text-caption text-bad">
                {errors.price}
              </p>
            )}
          </div>
          <div>
            <label htmlFor={ids.lead} className="mb-1.5 block text-label">
              Lead time (days)
            </label>
            <input
              id={ids.lead}
              className="bs-input text-right tabular-nums"
              inputMode="numeric"
              value={lead}
              onChange={(e) => setLead(e.target.value)}
              placeholder="0"
              disabled={closed}
              aria-invalid={!!errors.lead}
              aria-describedby={errors.lead ? `${ids.lead}-err` : undefined}
            />
            {errors.lead && (
              <p id={`${ids.lead}-err`} className="mt-1 text-caption text-bad">
                {errors.lead}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-lg border bg-surface-2 px-4 py-3" aria-live="polite">
          <span className="text-caption tabular-nums text-text-2">
            Total · {formatQuantity(rfq.quantity)} {rfq.unit} × {priceOk && !closed ? formatUnitPrice(p) : "—"}
          </span>
          <span className="text-title-1 tabular-nums">{priceOk && !closed ? formatMoney(p * rfq.quantity) : "—"}</span>
        </div>

        <button type="submit" className="bs-btn-primary h-10 w-full" disabled={closed || submitting}>
          {closed ? "Bidding closed" : submitting ? "Submitting…" : err && (syncing || err.retryable) ? "Try again" : "Submit bid"}
        </button>

        <p className="break-all font-mono text-mono-xs text-text-3">POST /v1/rfqs/{rfq.rfq_id}/bids → bid.submitted</p>
      </form>
    </section>
  );
}
