/** RFC 3339 in UTC with second precision, e.g. `2026-11-16T17:00:00Z` (see contracts.md). */
export function toRfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
