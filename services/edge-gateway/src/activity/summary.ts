import type { ActivityEvent } from "../types.js";

export type EventEnvelope = {
  event_id: string;
  event_type: string;
  version: number;
  occurred_at: string;
  tenant_id: string;
  key: string;
  data: Record<string, unknown>;
};

export const KNOWN_EVENT_TYPES = ["rfq.created", "rfq.awarded", "bid.submitted"] as const;

const usd = (v: unknown) => `$${Number(v).toFixed(2)}`;
const thousands = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Human one-liner shown in the activity feed; null for event types we do not render. */
export function buildSummary(eventType: string, data: Record<string, unknown>): string | null {
  switch (eventType) {
    case "bid.submitted":
    case "rfq.awarded":
      return `${String(data.supplier_name ?? "Unknown supplier")} ${usd(data.unit_price)}`;
    case "rfq.created":
      return `${String(data.sku ?? "?")} × ${thousands.format(Number(data.quantity ?? 0))}`;
    default:
      return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export class MalformedEventError extends Error {}

/** Parses and validates an event envelope. Throws MalformedEventError when it is not one. */
export function parseEnvelope(value: Buffer | string | null): EventEnvelope {
  if (value === null || value.length === 0) throw new MalformedEventError("empty message value");
  let raw: unknown;
  try {
    raw = JSON.parse(value.toString());
  } catch {
    throw new MalformedEventError("value is not JSON");
  }
  if (!isObject(raw)) throw new MalformedEventError("envelope is not an object");
  for (const field of ["event_id", "event_type", "occurred_at", "tenant_id"] as const) {
    if (!isNonEmptyString(raw[field])) throw new MalformedEventError(`envelope.${field} missing`);
  }
  if (Number.isNaN(Date.parse(raw.occurred_at as string))) {
    throw new MalformedEventError("envelope.occurred_at is not a timestamp");
  }
  if (!isObject(raw.data)) throw new MalformedEventError("envelope.data is not an object");
  return {
    event_id: raw.event_id as string,
    event_type: raw.event_type as string,
    version: typeof raw.version === "number" ? raw.version : 1,
    occurred_at: raw.occurred_at as string,
    tenant_id: raw.tenant_id as string,
    key: typeof raw.key === "string" ? raw.key : "",
    data: raw.data,
  };
}

/** ActivityEvent for a known event type, or null for types the feed ignores. */
export function toActivityEvent(topic: string, envelope: EventEnvelope, messageKey?: string): ActivityEvent | null {
  const summary = buildSummary(envelope.event_type, envelope.data);
  if (summary === null) return null;
  return {
    event_id: envelope.event_id,
    topic,
    event_type: envelope.event_type,
    key: envelope.key || messageKey || "",
    occurred_at: envelope.occurred_at,
    summary,
    data: envelope.data,
  };
}
