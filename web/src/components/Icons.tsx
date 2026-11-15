import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;
const base = (p: P): P => ({
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
  ...p,
});

export const PlusIcon = (p: P) => (
  <svg {...base(p)}><path d="M12 5v14M5 12h14" /></svg>
);
export const CloseIcon = (p: P) => (
  <svg {...base(p)}><path d="M18 6 6 18M6 6l12 12" /></svg>
);
export const ChevronRightIcon = (p: P) => (
  <svg {...base(p)}><path d="m9 18 6-6-6-6" /></svg>
);
export const ChevronLeftIcon = (p: P) => (
  <svg {...base(p)}><path d="m15 18-6-6 6-6" /></svg>
);
export const CheckIcon = (p: P) => (
  <svg {...base(p)}><path d="M20 6 9 17l-5-5" /></svg>
);
export const ClockIcon = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const LockIcon = (p: P) => (
  <svg {...base(p)}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
);
export const AlertIcon = (p: P) => (
  <svg {...base(p)}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg>
);
export const RefreshIcon = (p: P) => (
  <svg {...base(p)}><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5M3 21v-5h5" /></svg>
);
export const ActivityIcon = (p: P) => (
  <svg {...base(p)}><path d="M3 12h4l3-8 4 16 3-8h4" /></svg>
);
export const FilePlusIcon = (p: P) => (
  <svg {...base(p)}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M12 11v6M9 14h6" /></svg>
);
export const SunIcon = (p: P) => (
  <svg {...base(p)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
);
export const MoonIcon = (p: P) => (
  <svg {...base(p)}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></svg>
);
export const SortIcon = ({ dir, ...p }: P & { dir: "asc" | "desc" | null }) =>
  dir === null ? (
    <svg {...base({ width: 12, height: 12, ...p })}><path d="m8 9 4-4 4 4M8 15l4 4 4-4" /></svg>
  ) : dir === "desc" ? (
    <svg {...base({ width: 12, height: 12, ...p })}><path d="M12 5v14M6 13l6 6 6-6" /></svg>
  ) : (
    <svg {...base({ width: 12, height: 12, ...p })}><path d="M12 19V5M6 11l6-6 6 6" /></svg>
  );

export const Logo = (p: P) => (
  <svg width={24} height={24} viewBox="0 0 24 24" aria-hidden focusable={false} {...p}>
    <rect width="24" height="24" rx="5" className="fill-accent" />
    <rect x="6" y="7.5" width="12" height="2" rx="1" fill="#fff" />
    <rect x="6" y="11" width="9" height="2" rx="1" fill="#fff" />
    <rect x="6" y="14.5" width="6" height="2" rx="1" fill="#fff" />
  </svg>
);
