import type { Queryable } from '../db/pool.js';
import type { EventEnvelope } from './envelope.js';

/**
 * Stages an event for the relay. Must run in the same transaction as the
 * business write it describes, so both commit or neither does.
 */
export async function enqueueEvent(
  db: Queryable,
  args: { topic: string; envelope: EventEnvelope<unknown>; headers?: Record<string, string> },
): Promise<void> {
  const headers = { event_type: args.envelope.event_type, ...args.headers };
  await db.query(
    `INSERT INTO outbox (event_id, topic, key, payload, headers)
     VALUES ($1, $2, $3, $4, $5)`,
    [args.envelope.event_id, args.topic, args.envelope.key, JSON.stringify(args.envelope), JSON.stringify(headers)],
  );
}
