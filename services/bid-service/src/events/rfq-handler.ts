import { withTransaction, type Pool, type PoolClient } from '../db/pool.js';
import { PermanentEventError, readInteger, readString, readTimestamp, type EventEnvelope } from './envelope.js';

export const CONSUMER_NAME = 'bid-service';

export type HandleOutcome = 'applied' | 'duplicate' | 'ignored';

type Apply = (tx: PoolClient, event: EventEnvelope) => Promise<void>;

/**
 * rfq.created opens the RFQ in the local view. On conflict only the details are
 * refreshed, never the status: a late rfq.created must not reopen an award.
 */
const applyRfqCreated: Apply = async (tx, event) => {
  const { data } = event;
  const rfqId = readString(data, 'rfq_id');
  const deadline = readTimestamp(data, 'deadline');
  const quantity = readInteger(data, 'quantity');
  const { rowCount } = await tx.query(
    `INSERT INTO rfq_view (rfq_id, tenant_id, status, deadline, quantity, updated_at)
     VALUES ($1, $2, 'open', $3, $4, now())
     ON CONFLICT (rfq_id) DO UPDATE
       SET deadline = EXCLUDED.deadline, quantity = EXCLUDED.quantity, updated_at = now()
       WHERE rfq_view.tenant_id = EXCLUDED.tenant_id`,
    [rfqId, event.tenant_id, deadline, quantity],
  );
  if (rowCount === 0) throw new PermanentEventError(`rfq ${rfqId} already belongs to another tenant`);
};

/**
 * rfq.awarded closes the RFQ. If rfq.created was never seen the row is created
 * as awarded (deadline = award time) so bids get FAILED_PRECONDITION, not NOT_FOUND.
 */
const applyRfqAwarded: Apply = async (tx, event) => {
  const { data } = event;
  const rfqId = readString(data, 'rfq_id');
  const awardedAt = readTimestamp(data, 'awarded_at');
  const quantity = readInteger(data, 'quantity');
  const { rowCount } = await tx.query(
    `INSERT INTO rfq_view (rfq_id, tenant_id, status, deadline, quantity, updated_at)
     VALUES ($1, $2, 'awarded', $3, $4, now())
     ON CONFLICT (rfq_id) DO UPDATE
       SET status = 'awarded', updated_at = now()
       WHERE rfq_view.tenant_id = EXCLUDED.tenant_id`,
    [rfqId, event.tenant_id, awardedAt, quantity],
  );
  if (rowCount === 0) throw new PermanentEventError(`rfq ${rfqId} already belongs to another tenant`);
};

const HANDLERS: Record<string, Apply> = {
  'rfq.created': applyRfqCreated,
  'rfq.awarded': applyRfqAwarded,
};

/**
 * Applies one rfq.events envelope exactly once: the processed_events marker and
 * the side effect commit in the same transaction, so a redelivery is a no-op.
 */
export async function handleRfqEvent(pool: Pool, event: EventEnvelope): Promise<HandleOutcome> {
  const apply = HANDLERS[event.event_type];
  if (!apply) return 'ignored'; // forward compatibility: unknown types are skipped

  return withTransaction(pool, async (tx) => {
    const { rowCount } = await tx.query(
      `INSERT INTO processed_events (event_id, consumer) VALUES ($1, $2)
       ON CONFLICT (event_id, consumer) DO NOTHING`,
      [event.event_id, CONSUMER_NAME],
    );
    if (rowCount === 0) return 'duplicate';
    await apply(tx, event);
    return 'applied';
  });
}
