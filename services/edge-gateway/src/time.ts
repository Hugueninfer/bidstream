/** RFC 3339 UTC timestamp without fractional seconds, e.g. 2026-11-16T17:00:00Z. */
export function rfc3339(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
