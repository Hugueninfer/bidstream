import { isApiError } from "../api/client";
import { AlertIcon } from "./Icons";

/** Generic "couldn't load" card with retry. */
export function ErrorCard({ error, onRetry, what }: { error: unknown; onRetry?: () => void; what: string }) {
  const detail = isApiError(error) ? `${error.status || "network"} ${error.code} · ${error.message}` : String(error);
  return (
    <div role="alert" className="bs-card flex items-start gap-3 p-5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-bad-soft text-bad">
        <AlertIcon />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-section">Couldn't load {what}</p>
        <p className="mt-1 break-words font-mono text-mono-xs text-text-3">{detail}</p>
      </div>
      {onRetry && (
        <button type="button" className="bs-btn-secondary bs-btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
