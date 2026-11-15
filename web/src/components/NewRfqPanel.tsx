import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, isApiError } from "../api/client";
import { qk, useEstimate, useSkus } from "../api/queries";
import type { Rfq } from "../api/types";
import {
  dateTimeLocalToRfc3339,
  formatDistance,
  formatMoney,
  formatModel,
  formatQuantity,
  formatUnitPrice,
  toDateTimeLocalValue,
} from "../lib/format";
import { useDebounced, useModal } from "../lib/hooks";
import { CloseIcon } from "./Icons";
import { Skeleton } from "./ui";

function defaultDeadline(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  d.setHours(17, 0, 0, 0);
  return toDateTimeLocalValue(d);
}

type Errors = Partial<Record<"title" | "sku" | "quantity" | "deadline", string>>;

function EstimatePreview({ sku, qty, unit }: { sku: string; qty: number | null; unit: string }) {
  const debouncedQty = useDebounced(qty, 300);
  const debouncedSku = useDebounced(sku, 300);
  const est = useEstimate(debouncedSku, debouncedQty);
  const settling = debouncedQty !== qty || debouncedSku !== sku;

  let body;
  if (!sku || qty === null || qty <= 0) {
    body = <p className="text-caption text-text-3">Pick a SKU and quantity to see the predicted price.</p>;
  } else if (est.isError) {
    body = (
      <p className="text-caption text-warn">
        Price preview unavailable{isApiError(est.error) ? ` (${est.error.code})` : ""}. You can still create the RFQ;
        the estimate fills in once pricing-service recovers.
      </p>
    );
  } else if (!est.data || settling || est.isFetching) {
    body = (
      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-3 w-64" />
      </div>
    );
  } else {
    const e = est.data;
    body = (
      <>
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span>
            <span className="text-[22px] font-semibold leading-7 tabular-nums">
              {formatUnitPrice(e.estimated_unit_price)}
            </span>{" "}
            <span className="text-text-3">/ {unit}</span>
          </span>
          <span className="tabular-nums text-text-2">
            band {formatUnitPrice(e.low)} – {formatUnitPrice(e.high)}
          </span>
        </div>
        <p className="mt-2 text-caption tabular-nums text-text-2">
          Expected total ≈ {formatMoney(e.estimated_unit_price * e.quantity)} · based on{" "}
          {formatQuantity(e.sample_size)} past awards
        </p>
      </>
    );
  }

  return (
    <div className="rounded-lg border bg-surface-2 p-4" aria-live="polite" aria-busy={est.isFetching}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-label">Predicted price</span>
        {est.data && !settling && (
          <>
            <span className="bs-chip bg-surface">model {formatModel(est.data.model_version)}</span>
            <span className={`bs-chip ${est.data.cache_hit ? "bg-good-soft text-good" : "bg-surface"}`}>
              {est.data.cache_hit ? "cache hit" : "cache miss"}
            </span>
            <span className="font-mono text-mono-xs text-text-3">{est.data.latency_ms} ms</span>
          </>
        )}
      </div>
      {body}
    </div>
  );
}

/** Right sheet for creating an RFQ, with a live (debounced) price preview from GET /v1/estimate. */
export function NewRfqPanel({ onClose, onCreated }: { onClose: () => void; onCreated: (rfq: Rfq) => void }) {
  const titleId = useId();
  const ids = { title: useId(), sku: useId(), qty: useId(), unit: useId(), deadline: useId(), help: useId() };
  const skus = useSkus();
  const queryClient = useQueryClient();
  const firstField = useRef<HTMLInputElement>(null);
  const ref = useModal<HTMLDivElement>(true, onClose, firstField);

  const [title, setTitle] = useState("");
  const [sku, setSku] = useState("");
  const [unit, setUnit] = useState("");
  const [qtyText, setQtyText] = useState("");
  const [deadline, setDeadline] = useState(defaultDeadline);
  const [errors, setErrors] = useState<Errors>({});
  const [submitted, setSubmitted] = useState(false);

  const skuList = useMemo(() => skus.data?.skus ?? [], [skus.data]);
  const effectiveSku = sku || skuList[0]?.sku || "";
  const effectiveUnit = unit || skuList.find((s) => s.sku === effectiveSku)?.unit || "";
  const units = useMemo(() => [...new Set(skuList.map((s) => s.unit))], [skuList]);

  const qty = /^\d+$/.test(qtyText.trim()) ? Number(qtyText) : null;
  const deadlineIso = dateTimeLocalToRfc3339(deadline);
  const deadlineMs = deadlineIso ? Date.parse(deadlineIso) - Date.now() : null;

  const validate = (): Errors => {
    const e: Errors = {};
    if (!title.trim()) e.title = "Give the RFQ a title suppliers will recognise.";
    if (!effectiveSku) e.sku = "Pick a SKU.";
    if (qty === null || qty <= 0) e.quantity = "Enter a whole quantity above 0.";
    if (!deadlineIso) e.deadline = "Pick a deadline.";
    else if (deadlineMs !== null && deadlineMs <= 60_000) e.deadline = "The deadline must be in the future.";
    return e;
  };

  const create = useMutation({
    mutationFn: () =>
      api.createRfq({
        title: title.trim(),
        sku: effectiveSku,
        quantity: qty!,
        unit: effectiveUnit,
        deadline: deadlineIso!,
      }),
    onSuccess: (rfq) => {
      queryClient.setQueryData(qk.rfq(rfq.rfq_id), rfq);
      void queryClient.invalidateQueries({ queryKey: qk.rfqsAll });
      onCreated(rfq);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length === 0) create.mutate();
  };

  // Re-validate live once the user has tried to submit.
  const shown = submitted ? validate() : errors;

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/35" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="absolute inset-y-0 right-0 flex w-full max-w-[478px] flex-col border-l bg-surface shadow-2xl motion-safe:animate-sheet-in"
      >
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 id={titleId} className="text-title-2">
            New RFQ
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-text-2 hover:bg-surface-2 hover:text-text"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>

        <form id="new-rfq" onSubmit={onSubmit} noValidate className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {create.isError && (
            <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft px-4 py-3 text-body text-bad">
              {isApiError(create.error)
                ? `${create.error.message}${create.error.code === "validation_error" ? "" : ` (${create.error.code})`}`
                : "Couldn't create the RFQ. Try again."}
            </div>
          )}

          <div>
            <label htmlFor={ids.title} className="mb-1.5 block text-label">
              Title
            </label>
            <input
              id={ids.title}
              ref={firstField}
              className="bs-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Machine lubricant 5 L — Q1 maintenance"
              maxLength={200}
              aria-invalid={!!shown.title}
              aria-describedby={shown.title ? `${ids.title}-err` : undefined}
            />
            {shown.title && (
              <p id={`${ids.title}-err`} className="mt-1 text-caption text-bad">
                {shown.title}
              </p>
            )}
          </div>

          <div>
            <label htmlFor={ids.sku} className="mb-1.5 block text-label">
              SKU
            </label>
            <select
              id={ids.sku}
              className="bs-input font-mono"
              value={effectiveSku}
              disabled={skus.isLoading}
              onChange={(e) => {
                setSku(e.target.value);
                setUnit(skuList.find((s) => s.sku === e.target.value)?.unit ?? "");
              }}
              aria-invalid={!!shown.sku}
            >
              {skus.isLoading && <option>Loading…</option>}
              {skuList.map((s) => (
                <option key={s.sku} value={s.sku}>
                  {s.sku}
                </option>
              ))}
            </select>
            {skus.isError && <p className="mt-1 text-caption text-bad">Couldn't load SKUs from /v1/skus.</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor={ids.qty} className="mb-1.5 block text-label">
                Quantity
              </label>
              <input
                id={ids.qty}
                className="bs-input text-right tabular-nums"
                inputMode="numeric"
                type="number"
                min={1}
                step={1}
                value={qtyText}
                onChange={(e) => setQtyText(e.target.value)}
                placeholder="0"
                aria-invalid={!!shown.quantity}
                aria-describedby={shown.quantity ? `${ids.qty}-err` : undefined}
              />
              {shown.quantity && (
                <p id={`${ids.qty}-err`} className="mt-1 text-caption text-bad">
                  {shown.quantity}
                </p>
              )}
            </div>
            <div>
              <label htmlFor={ids.unit} className="mb-1.5 block text-label">
                Unit
              </label>
              <select
                id={ids.unit}
                className="bs-input"
                value={effectiveUnit}
                onChange={(e) => setUnit(e.target.value)}
              >
                {units.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label htmlFor={ids.deadline} className="mb-1.5 block text-label">
              Deadline
            </label>
            <input
              id={ids.deadline}
              type="datetime-local"
              className="bs-input tabular-nums"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              aria-invalid={!!shown.deadline}
              aria-describedby={ids.help}
            />
            <p id={ids.help} className={`mt-1.5 text-caption ${shown.deadline ? "text-bad" : "text-text-2"}`}>
              {shown.deadline ??
                (deadlineMs !== null && deadlineMs > 0
                  ? `Bidding closes automatically at this time (in ${formatDistance(deadlineMs)}).`
                  : "Bidding closes automatically at this time.")}
            </p>
          </div>

          <EstimatePreview sku={effectiveSku} qty={qty} unit={effectiveUnit} />
        </form>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-4">
          <span className="font-mono text-mono-xs text-text-3">emits rfq.created → rfq.events</span>
          <div className="flex gap-2">
            <button type="button" className="bs-btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" form="new-rfq" className="bs-btn-primary" disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create RFQ"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
