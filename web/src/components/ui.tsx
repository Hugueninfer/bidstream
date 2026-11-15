import type { ReactNode } from "react";

export function Dot({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${className}`} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`bs-card ${className}`}>{children}</section>;
}

/** Small "Live" pill (or reconnecting) used in the drawer and bids header. */
export function LivePill({ live, compact = false }: { live: boolean; compact?: boolean }) {
  return live ? (
    <span
      className={`inline-flex items-center gap-1 rounded-full text-caption font-medium text-good ${
        compact ? "" : "bg-good-soft px-2 py-0.5"
      }`}
    >
      <Dot className="h-1.5 w-1.5 bg-good" />
      Live
    </span>
  ) : (
    <span
      className={`inline-flex items-center gap-1 rounded-full text-caption font-medium text-warn ${
        compact ? "" : "bg-warn-soft px-2 py-0.5"
      }`}
    >
      <Dot className="h-1.5 w-1.5 bg-warn motion-safe:animate-pulse" />
      Reconnecting…
    </span>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`bs-skeleton ${className}`} />;
}

/** Visually hidden but announced. */
export function SrOnly({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
