import type { Queryable } from '../db/pool.js';
import { toRfc3339 } from '../domain/time.js';

/** A bid in its wire shape (bidstream.bid.v1.Bid and the bid.submitted payload). */
export interface Bid {
  bid_id: string;
  tenant_id: string;
  rfq_id: string;
  supplier_id: string;
  supplier_name: string;
  unit_price: number;
  currency: 'USD';
  lead_time_days: number;
  submitted_at: string;
}

export interface RfqViewRow {
  status: 'open' | 'awarded';
  deadline: Date;
}

interface BidRow {
  bid_id: string;
  tenant_id: string;
  rfq_id: string;
  supplier_id: string;
  supplier_name: string;
  unit_price: string; // NUMERIC comes back as a string
  currency: string;
  lead_time_days: number;
  submitted_at: Date;
}

const BID_COLUMNS =
  'bid_id, tenant_id, rfq_id, supplier_id, supplier_name, unit_price, currency, lead_time_days, submitted_at';

function toBid(row: BidRow): Bid {
  return {
    bid_id: row.bid_id,
    tenant_id: row.tenant_id,
    rfq_id: row.rfq_id,
    supplier_id: row.supplier_id,
    supplier_name: row.supplier_name,
    unit_price: Number(row.unit_price),
    currency: 'USD',
    lead_time_days: row.lead_time_days,
    submitted_at: toRfc3339(row.submitted_at),
  };
}

export async function findBid(db: Queryable, tenantId: string, bidId: string): Promise<Bid | null> {
  const { rows } = await db.query<BidRow>(`SELECT ${BID_COLUMNS} FROM bids WHERE tenant_id = $1 AND bid_id = $2`, [
    tenantId,
    bidId,
  ]);
  return rows[0] ? toBid(rows[0]) : null;
}

export async function findBidByIdempotencyKey(db: Queryable, tenantId: string, key: string): Promise<Bid | null> {
  const { rows } = await db.query<BidRow>(
    `SELECT ${BID_COLUMNS} FROM bids WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, key],
  );
  return rows[0] ? toBid(rows[0]) : null;
}

export async function listBids(db: Queryable, tenantId: string, rfqId: string): Promise<Bid[]> {
  const { rows } = await db.query<BidRow>(
    `SELECT ${BID_COLUMNS} FROM bids
     WHERE tenant_id = $1 AND rfq_id = $2
     ORDER BY submitted_at DESC, bid_id DESC`,
    [tenantId, rfqId],
  );
  return rows.map(toBid);
}

/**
 * Inserts the bid unless another bid already holds the same idempotency key
 * for the tenant (a concurrent replay); returns whether the row was written.
 */
export async function insertBid(db: Queryable, bid: Bid, submittedAt: Date, idempotencyKey: string | null): Promise<boolean> {
  const { rowCount } = await db.query(
    `INSERT INTO bids (bid_id, tenant_id, rfq_id, supplier_id, supplier_name, unit_price, currency,
                       lead_time_days, submitted_at, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, idempotency_key) DO NOTHING`,
    [
      bid.bid_id,
      bid.tenant_id,
      bid.rfq_id,
      bid.supplier_id,
      bid.supplier_name,
      bid.unit_price,
      bid.currency,
      bid.lead_time_days,
      submittedAt,
      idempotencyKey,
    ],
  );
  return rowCount === 1;
}

/**
 * Reads the RFQ's state with a share lock, so an rfq.awarded being applied
 * concurrently waits for this bid's transaction (and vice versa).
 */
export async function lockRfqView(db: Queryable, tenantId: string, rfqId: string): Promise<RfqViewRow | null> {
  const { rows } = await db.query<RfqViewRow>(
    'SELECT status, deadline FROM rfq_view WHERE tenant_id = $1 AND rfq_id = $2 FOR SHARE',
    [tenantId, rfqId],
  );
  return rows[0] ?? null;
}
