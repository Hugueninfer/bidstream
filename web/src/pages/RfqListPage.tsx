import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useRfqs } from "../api/queries";
import type { RfqStatus } from "../api/types";
import { EmptyState } from "../components/EmptyState";
import { ErrorCard } from "../components/ErrorCard";
import { FilePlusIcon, PlusIcon } from "../components/Icons";
import { NewRfqPanel } from "../components/NewRfqPanel";
import { RfqTable, RfqTableSkeleton } from "../components/RfqTable";
import { formatModel } from "../lib/format";

const FILTERS: { key: RfqStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "open", label: "Open" },
  { key: "awarded", label: "Awarded" },
  { key: "expired", label: "Expired" },
];

export function RfqListPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("status");
  const status = raw === "open" || raw === "awarded" || raw === "expired" ? raw : undefined;
  const q = useRfqs(status);
  const [panelOpen, setPanelOpen] = useState(false);
  const navigate = useNavigate();

  const counts = q.data?.counts;
  const isEmpty = counts?.all === 0;
  const model = q.data?.rfqs.find((r) => r.estimate)?.estimate?.model_version ?? "v1";

  const newButton = (
    <button type="button" className="bs-btn-primary" onClick={() => setPanelOpen(true)}>
      <PlusIcon /> New RFQ
    </button>
  );

  return (
    <div className="mx-auto max-w-[1080px]">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-title-1">Requests for quote</h1>
          <p className="mt-0.5 text-body text-text-2 tabular-nums">
            {counts ? (isEmpty ? "Buyer workspace" : `${counts.all} RFQs · ${counts.open} open`) : " "}
          </p>
        </div>
        {newButton}
      </div>

      {!isEmpty && (
        <nav aria-label="Filter by status" className="mb-5 flex flex-wrap gap-1">
          {FILTERS.map((f) => {
            const active = (status ?? "all") === f.key;
            const n = counts?.[f.key];
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  if (f.key === "all") next.delete("status");
                  else next.set("status", f.key);
                  setParams(next, { replace: true });
                }}
                className={`rounded-lg border px-2.5 py-1.5 text-body font-medium ${
                  active ? "border-border bg-surface text-text shadow-sm" : "border-transparent text-text-2 hover:text-text"
                }`}
              >
                {f.label}
                {n !== undefined && <span className="ml-1.5 text-caption tabular-nums text-text-3">{n}</span>}
              </button>
            );
          })}
        </nav>
      )}

      {q.isPending ? (
        <RfqTableSkeleton />
      ) : q.isError ? (
        <ErrorCard what="RFQs" error={q.error} onRetry={() => void q.refetch()} />
      ) : isEmpty ? (
        <EmptyState
          bordered
          tone="accent"
          icon={<FilePlusIcon />}
          title="No RFQs yet"
          action={newButton}
        >
          Create a request for quote and suppliers can bid on it straight away. Each step also shows up in System
          activity as an event.
        </EmptyState>
      ) : q.data.rfqs.length === 0 ? (
        <div className="bs-card px-6 py-10 text-center text-body text-text-2">No {status} RFQs.</div>
      ) : (
        <>
          <RfqTable rfqs={q.data.rfqs} />
          <p className="mt-6 text-caption text-text-2">
            Predicted prices come from pricing-service (model {formatModel(model)}). Bands show the 80% range of
            comparable awards.
          </p>
        </>
      )}

      {panelOpen && (
        <NewRfqPanel
          onClose={() => setPanelOpen(false)}
          onCreated={(rfq) => {
            setPanelOpen(false);
            navigate(`/rfqs/${rfq.rfq_id}`);
          }}
        />
      )}
    </div>
  );
}
