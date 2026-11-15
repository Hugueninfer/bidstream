import { randomUUID } from 'node:crypto';
import { toRfc3339 } from '../domain/time.js';

export const BID_EVENTS_TOPIC = 'bid.events';
export const RFQ_EVENTS_TOPIC = 'rfq.events';

/** Event envelope shared by every topic (docs/contracts.md, "Events"). */
export interface EventEnvelope<T = Record<string, unknown>> {
  event_id: string;
  event_type: string;
  version: number;
  occurred_at: string;
  tenant_id: string;
  key: string;
  data: T;
}

export interface BidSubmittedData {
  bid_id: string;
  rfq_id: string;
  tenant_id: string;
  supplier_id: string;
  supplier_name: string;
  unit_price: number;
  currency: 'USD';
  lead_time_days: number;
  submitted_at: string;
}

export function buildEnvelope<T>(args: {
  eventType: string;
  tenantId: string;
  key: string;
  data: T;
  occurredAt?: Date;
  eventId?: string;
}): EventEnvelope<T> {
  return {
    event_id: args.eventId ?? randomUUID(),
    event_type: args.eventType,
    version: 1,
    occurred_at: toRfc3339(args.occurredAt ?? new Date()),
    tenant_id: args.tenantId,
    key: args.key,
    data: args.data,
  };
}

/**
 * A message that can never be processed, however often it is retried
 * (malformed JSON, missing fields). It goes straight to the DLQ.
 */
export class PermanentEventError extends Error {
  override name = 'PermanentEventError';
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses and checks the envelope fields every consumer relies on. */
export function parseEnvelope(raw: Buffer | string | null): EventEnvelope {
  if (raw === null) throw new PermanentEventError('message has no value');
  let value: unknown;
  try {
    value = JSON.parse(raw.toString());
  } catch {
    throw new PermanentEventError('message value is not valid JSON');
  }
  if (!isRecord(value)) throw new PermanentEventError('envelope must be a JSON object');

  const { event_id, event_type, tenant_id, data } = value;
  if (typeof event_id !== 'string' || !UUID_PATTERN.test(event_id)) {
    throw new PermanentEventError('envelope.event_id must be a UUID');
  }
  if (typeof event_type !== 'string' || !event_type) throw new PermanentEventError('envelope.event_type is required');
  if (typeof tenant_id !== 'string' || !tenant_id) throw new PermanentEventError('envelope.tenant_id is required');
  if (!isRecord(data)) throw new PermanentEventError('envelope.data must be an object');

  return {
    event_id,
    event_type,
    version: typeof value.version === 'number' ? value.version : 1,
    occurred_at: typeof value.occurred_at === 'string' ? value.occurred_at : '',
    tenant_id,
    key: typeof value.key === 'string' ? value.key : '',
    data,
  };
}

// --- field readers for event data, throwing PermanentEventError ---

export function readString(data: Record<string, unknown>, field: string): string {
  const value = data[field];
  if (typeof value !== 'string' || !value.trim()) throw new PermanentEventError(`data.${field} must be a non-empty string`);
  return value;
}

export function readTimestamp(data: Record<string, unknown>, field: string): Date {
  const date = new Date(readString(data, field));
  if (Number.isNaN(date.getTime())) throw new PermanentEventError(`data.${field} must be an RFC 3339 timestamp`);
  return date;
}

/** int64 values may arrive as JSON numbers or strings depending on the producer. */
export function readInteger(data: Record<string, unknown>, field: string): number {
  const raw = data[field];
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new PermanentEventError(`data.${field} must be an integer`);
  }
  return value;
}
