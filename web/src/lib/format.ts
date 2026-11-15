// Number, money and time formatting. All figures are rendered with tabular-nums by the caller.

const MINUS = "−"; // typographic minus, as in the design ("−17.0%")

const usd2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const int = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Unit price: always 2 decimals ($0.47, $1,240.00). */
export function formatUnitPrice(n: number): string {
  return fixNegZero(usd2.format(n));
}

/** Totals: thousands separators and 2 decimals ($18,800.00). */
export function formatMoney(n: number): string {
  return fixNegZero(usd2.format(n));
}

function fixNegZero(s: string): string {
  return s.replace(/^-\$0\.00$/, "$0.00").replace(/^-/, MINUS);
}

/** Integer quantity with thousands separators (40,000). */
export function formatQuantity(n: number): string {
  return int.format(n);
}

/** Signed percentage from a fraction: −0.17 → "−17.0%", 0.139 → "+13.9%", 0 → "0.0%". */
export function formatSignedPct(fraction: number, digits = 1): string {
  const pct = fraction * 100;
  const abs = Math.abs(pct).toFixed(digits);
  if (Number(abs) === 0) return `${(0).toFixed(digits)}%`;
  return `${pct < 0 ? MINUS : "+"}${abs}%`;
}

/** Unsigned percentage from a fraction: 0.17 → "17.0%". */
export function formatPct(fraction: number, digits = 1): string {
  return `${Math.abs(fraction * 100).toFixed(digits)}%`;
}

const pad = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const toDate = (d: Date | string | number) => (d instanceof Date ? d : new Date(d));

/** "14:02:11" (local, 24 h). */
export function formatClock(d: Date | string | number): string {
  const x = toDate(d);
  return `${pad(x.getHours())}:${pad(x.getMinutes())}:${pad(x.getSeconds())}`;
}

/** "Nov 16, 17:00" (local, 24 h). */
export function formatDateTime(d: Date | string | number): string {
  const x = toDate(d);
  return `${MONTHS[x.getMonth()]} ${x.getDate()}, ${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

/** "Nov 12". */
export function formatDay(d: Date | string | number): string {
  const x = toDate(d);
  return `${MONTHS[x.getMonth()]} ${x.getDate()}`;
}

/** Ticking countdown: "2d 02:50:21", "02:50:21" under a day, "00:00:00" when elapsed. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const clock = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function plural(n: number, unit: string) {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Coarse human distance: "2 days", "18 hours", "45 minutes", "under a minute". */
export function formatDistance(ms: number): string {
  const a = Math.abs(ms);
  if (a < MIN) return "under a minute";
  if (a < HOUR) return plural(Math.round(a / MIN), "minute");
  if (a < DAY) {
    const h = Math.round(a / HOUR);
    return h >= 24 ? plural(1, "day") : plural(h, "hour");
  }
  return plural(Math.round(a / DAY), "day");
}

/** Deadline relative to now: "in 2 days" / "ended 9 days ago". */
export function formatDeadlineRelative(deadline: string | Date, now: number): string {
  const diff = toDate(deadline).getTime() - now;
  return diff > 0 ? `in ${formatDistance(diff)}` : `ended ${formatDistance(diff)} ago`;
}

/** True when a still-open deadline is less than 24 h away (rendered in warn). */
export function isClosingSoon(deadline: string | Date, now: number): boolean {
  const diff = toDate(deadline).getTime() - now;
  return diff > 0 && diff < DAY;
}

/** Compact "time ago" for bids: "just now", "19 s ago", "11 min ago", "1 h 15 min ago", "3 d ago". */
export function formatAgo(d: string | Date | number, now: number): string {
  const s = Math.max(0, Math.floor((now - toDate(d).getTime()) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min ago` : `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** "rfq_7f3a91c2b0de" → "rfq_7f3a" (design shows the prefix + 4 hex; full id goes in title). */
export function shortId(id: string): string {
  const i = id.indexOf("_");
  if (i < 0) return id;
  const prefix = id.slice(0, i);
  if (prefix !== "rfq" && prefix !== "bid") return id;
  return id.slice(0, i + 5);
}

/** "v1" stays "v1"; "1" becomes "v1". */
export function formatModel(version: string): string {
  return /^v/i.test(version) ? version : `v${version}`;
}

/** Date → value for <input type="datetime-local"> ("2026-11-21T17:00", local time). */
export function toDateTimeLocalValue(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value (local time) → RFC 3339 UTC without millis ("2026-11-21T16:00:00Z"); null if invalid. */
export function dateTimeLocalToRfc3339(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return null;
  const d = new Date(value); // no offset → parsed as local time
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
