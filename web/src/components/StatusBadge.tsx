import type { RfqStatus } from "../api/types";

const STYLES: Record<RfqStatus, { label: string; cls: string; dot: string }> = {
  open: { label: "Open", cls: "bg-accent-soft text-accent-text", dot: "bg-accent" },
  awarded: { label: "Awarded", cls: "bg-good-soft text-good", dot: "bg-good" },
  expired: { label: "Expired", cls: "bg-surface-2 text-text-2", dot: "bg-text-3" },
};

/** RFQ status pill: colour + dot + text label (colour is never the only signal). */
export function StatusBadge({ status, plain = false }: { status: RfqStatus; plain?: boolean }) {
  const s = STYLES[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-caption font-medium ${s.cls}`}
    >
      {!plain && <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} aria-hidden />}
      {s.label}
    </span>
  );
}
