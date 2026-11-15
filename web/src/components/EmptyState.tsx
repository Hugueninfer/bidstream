import type { ReactNode } from "react";

/** Centered empty state with icon tile, title, body and optional action/footer. */
export function EmptyState({
  icon,
  title,
  children,
  action,
  footer,
  tone = "neutral",
  bordered = false,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  footer?: ReactNode;
  tone?: "neutral" | "accent";
  bordered?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center px-6 py-12 text-center ${
        bordered ? "rounded-2xl border border-dashed border-border-strong bg-surface sm:py-[72px]" : ""
      }`}
    >
      <div
        className={`mb-4 flex h-11 w-11 items-center justify-center rounded-lg ${
          tone === "accent" ? "bg-accent-soft text-accent-text" : "bg-surface-2 text-text-2"
        }`}
      >
        {icon}
      </div>
      <h2 className="text-title-2 text-text">{title}</h2>
      {children && <div className="mt-2 max-w-md text-body text-text-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
      {footer && <div className="mt-4">{footer}</div>}
    </div>
  );
}
