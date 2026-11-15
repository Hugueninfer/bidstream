import { withTransaction, type Pool } from '../db/pool.js';
import { FailedPreconditionError, InvalidArgumentError, NotFoundError } from '../domain/errors.js';
import { newBidId } from '../domain/ids.js';
import { toRfc3339 } from '../domain/time.js';
import { validateSubmitBid, type SubmitBidInput } from '../domain/validation.js';
import { BID_EVENTS_TOPIC, buildEnvelope, type BidSubmittedData } from '../events/envelope.js';
import { enqueueEvent } from '../events/outbox.js';
import { currentTraceHeaders } from '../telemetry.js';
import * as repo from './repository.js';
import type { Bid } from './repository.js';

export type { Bid };

export interface SubmitBidResult {
  bid: Bid;
  /** True when the idempotency key matched an existing bid and nothing was written. */
  replay: boolean;
}

export class BidService {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async submitBid(input: SubmitBidInput): Promise<SubmitBidResult> {
    const draft = validateSubmitBid(input);

    // Fast path for retries: the original bid wins even if the RFQ has closed since.
    if (draft.idempotencyKey) {
      const existing = await repo.findBidByIdempotencyKey(this.pool, draft.tenantId, draft.idempotencyKey);
      if (existing) return { bid: existing, replay: true };
    }

    const submittedAt = this.now();
    const bid: Bid = {
      bid_id: newBidId(),
      tenant_id: draft.tenantId,
      rfq_id: draft.rfqId,
      supplier_id: draft.supplierId,
      supplier_name: draft.supplierName,
      unit_price: draft.unitPrice,
      currency: 'USD',
      lead_time_days: draft.leadTimeDays,
      submitted_at: toRfc3339(submittedAt),
    };

    const inserted = await withTransaction(this.pool, async (tx) => {
      const rfq = await repo.lockRfqView(tx, draft.tenantId, draft.rfqId);
      if (!rfq) throw new NotFoundError('rfq not known to bid-service yet');
      if (rfq.status !== 'open') throw new FailedPreconditionError(`rfq is ${rfq.status}, not open`);
      if (rfq.deadline.getTime() <= submittedAt.getTime()) {
        throw new FailedPreconditionError('rfq deadline has passed');
      }

      if (!(await repo.insertBid(tx, bid, submittedAt, draft.idempotencyKey))) return false;

      const data: BidSubmittedData = { ...bid };
      await enqueueEvent(tx, {
        topic: BID_EVENTS_TOPIC,
        envelope: buildEnvelope({
          eventType: 'bid.submitted',
          tenantId: bid.tenant_id,
          key: bid.rfq_id,
          data,
          occurredAt: submittedAt,
        }),
        headers: currentTraceHeaders(),
      });
      return true;
    });
    if (inserted) return { bid, replay: false };

    // Lost a race with a concurrent request carrying the same key: that one
    // committed first, so return its bid exactly like a replay.
    const winner = await repo.findBidByIdempotencyKey(this.pool, draft.tenantId, draft.idempotencyKey!);
    if (!winner) throw new Error('idempotency conflict but no bid found for the key');
    return { bid: winner, replay: true };
  }

  async getBid(input: { tenant_id?: string; bid_id?: string }): Promise<Bid> {
    const tenantId = requireField(input.tenant_id, 'tenant_id');
    const bidId = requireField(input.bid_id, 'bid_id');
    const bid = await repo.findBid(this.pool, tenantId, bidId);
    if (!bid) throw new NotFoundError(`bid ${bidId} not found`);
    return bid;
  }

  async listBids(input: { tenant_id?: string; rfq_id?: string }): Promise<Bid[]> {
    const tenantId = requireField(input.tenant_id, 'tenant_id');
    const rfqId = requireField(input.rfq_id, 'rfq_id');
    return repo.listBids(this.pool, tenantId, rfqId);
  }
}

function requireField(value: string | undefined, field: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new InvalidArgumentError(`${field} is required`);
  return trimmed;
}
