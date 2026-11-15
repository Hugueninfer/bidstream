import { status, type ServiceError } from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BidService } from '../../src/bids/service.js';
import { findProtoDir } from '../../src/config.js';
import type { Pool } from '../../src/db/pool.js';
import { BID_ID_PATTERN } from '../../src/domain/ids.js';
import { createGrpcServer, type GrpcServer } from '../../src/grpc/server.js';
import {
  call,
  cleanupTenant,
  createClient,
  rfqId,
  seedRfq,
  setupDatabase,
  silentLogger,
  uniqueTenant,
  type Bid,
} from './helpers.js';

let pool: Pool;
let server: GrpcServer;
let client: ReturnType<typeof createClient>;
const tenant = uniqueTenant();

beforeAll(async () => {
  pool = await setupDatabase();
  server = createGrpcServer({ bidService: new BidService(pool), protoDir: findProtoDir(), logger: silentLogger });
  const port = await server.listen(0);
  client = createClient(port);
});

afterAll(async () => {
  client?.close();
  await server?.shutdown(1_000);
  if (pool) {
    await cleanupTenant(pool, tenant);
    await pool.end();
  }
});

const submit = (request: object) => call<Bid>((cb) => client.SubmitBid(request, cb));

async function expectStatus(promise: Promise<unknown>, code: status, details?: string): Promise<void> {
  const err = (await promise.then(
    () => expect.fail(`expected ${status[code]}`),
    (e: unknown) => e,
  )) as ServiceError;
  expect(status[err.code]).toBe(status[code]);
  if (details) expect(err.details).toBe(details);
}

function bidRequest(rfq: string, extra: object = {}) {
  return {
    tenant_id: tenant,
    rfq_id: rfq,
    supplier_name: 'Kestrel Fastening Co.',
    unit_price: 0.39,
    lead_time_days: 14,
    ...extra,
  };
}

describe('SubmitBid', () => {
  it('stores the bid and stages bid.submitted in the outbox', async () => {
    const rfq = rfqId();
    await seedRfq(pool, { tenantId: tenant, rfqId: rfq });

    const { response: bid, metadata } = await submit(bidRequest(rfq, { unit_price: 0.123456 }));

    expect(bid).toMatchObject({
      tenant_id: tenant,
      rfq_id: rfq,
      supplier_id: 'sup_kestrel_fastening_co',
      supplier_name: 'Kestrel Fastening Co.',
      unit_price: 0.1235,
      currency: 'USD',
      lead_time_days: 14,
    });
    expect(bid.bid_id).toMatch(BID_ID_PATTERN);
    expect(bid.submitted_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(metadata.get('x-idempotent-replay')).toEqual([]);

    const { rows: bids } = await pool.query('SELECT unit_price FROM bids WHERE bid_id = $1', [bid.bid_id]);
    expect(bids).toEqual([{ unit_price: '0.1235' }]);

    const { rows: outbox } = await pool.query(
      `SELECT topic, key, payload, headers, published_at FROM outbox WHERE payload->'data'->>'bid_id' = $1`,
      [bid.bid_id],
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      topic: 'bid.events',
      key: rfq,
      headers: { event_type: 'bid.submitted' },
      payload: {
        event_type: 'bid.submitted',
        version: 1,
        tenant_id: tenant,
        key: rfq,
        occurred_at: bid.submitted_at,
        data: { ...bid },
      },
    });
  });

  it('replays an idempotency key: same bid, one row, x-idempotent-replay header', async () => {
    const rfq = rfqId();
    await seedRfq(pool, { tenantId: tenant, rfqId: rfq });
    const request = bidRequest(rfq, { idempotency_key: `key-${rfq}` });

    const first = await submit(request);
    const second = await submit({ ...request, unit_price: 99 }); // body is ignored on replay

    expect(second.response).toEqual(first.response);
    expect(second.metadata.get('x-idempotent-replay')).toEqual(['true']);
    const { rows } = await pool.query(
      `SELECT (SELECT count(*) FROM bids WHERE tenant_id = $1 AND rfq_id = $2)::int AS bids,
              (SELECT count(*) FROM outbox WHERE key = $2)::int AS events`,
      [tenant, rfq],
    );
    expect(rows[0]).toEqual({ bids: 1, events: 1 });
  });

  it('resolves concurrent requests with the same key to a single bid', async () => {
    const rfq = rfqId();
    await seedRfq(pool, { tenantId: tenant, rfqId: rfq });
    const request = bidRequest(rfq, { idempotency_key: `race-${rfq}` });

    const results = await Promise.all(Array.from({ length: 8 }, () => submit(request)));

    expect(new Set(results.map((r) => r.response.bid_id)).size).toBe(1);
    expect(results.filter((r) => r.metadata.get('x-idempotent-replay')[0] === 'true')).toHaveLength(7);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox WHERE key = $1', [rfq]);
    expect(rows[0].n).toBe(1);
  });

  it('returns NOT_FOUND when the RFQ is not in rfq_view yet', async () => {
    await expectStatus(submit(bidRequest(rfqId())), status.NOT_FOUND, 'rfq not known to bid-service yet');
  });

  it('returns NOT_FOUND for an RFQ of another tenant', async () => {
    const rfq = rfqId();
    await seedRfq(pool, { tenantId: tenant, rfqId: rfq });
    await expectStatus(submit({ ...bidRequest(rfq), tenant_id: uniqueTenant() }), status.NOT_FOUND);
  });

  it('returns FAILED_PRECONDITION when the RFQ is awarded', async () => {
    const rfq = rfqId();
    await seedRfq(pool, { tenantId: tenant, rfqId: rfq, status: 'awarded' });
    await expectStatus(submit(bidRequest(rfq)), status.FAILED_PRECONDITION, 'rfq is awarded, not open');
  });

  it('returns FAILED_PRECONDITION when the deadline has passed', async () => {
    const rfq = rfqId();
    await seedRfq(pool, { tenantId: tenant, rfqId: rfq, deadline: new Date(Date.now() - 1_000) });
    await expectStatus(submit(bidRequest(rfq)), status.FAILED_PRECONDITION, 'rfq deadline has passed');
  });

  it('returns INVALID_ARGUMENT for bad input without touching the database', async () => {
    await expectStatus(submit(bidRequest(rfqId(), { unit_price: -1 })), status.INVALID_ARGUMENT);
    await expectStatus(submit(bidRequest(rfqId(), { lead_time_days: 400 })), status.INVALID_ARGUMENT);
    await expectStatus(submit({ ...bidRequest(rfqId()), tenant_id: '' }), status.INVALID_ARGUMENT);
  });
});

describe('GetBid and ListBids', () => {
  it('gets a bid for its tenant only', async () => {
    const rfq = rfqId();
    await seedRfq(pool, { tenantId: tenant, rfqId: rfq });
    const { response: bid } = await submit(bidRequest(rfq));

    const { response } = await call<Bid>((cb) => client.GetBid({ tenant_id: tenant, bid_id: bid.bid_id }, cb));
    expect(response).toEqual(bid);
    await expectStatus(
      call<Bid>((cb) => client.GetBid({ tenant_id: uniqueTenant(), bid_id: bid.bid_id }, cb)),
      status.NOT_FOUND,
    );
    await expectStatus(
      call<Bid>((cb) => client.GetBid({ tenant_id: tenant, bid_id: 'bid_000000000000' }, cb)),
      status.NOT_FOUND,
    );
  });

  it('lists an RFQ’s bids newest first', async () => {
    const rfq = rfqId();
    await seedRfq(pool, { tenantId: tenant, rfqId: rfq });
    const submitted: string[] = [];
    for (const name of ['First Supplier', 'Second Supplier', 'Third Supplier']) {
      submitted.push((await submit(bidRequest(rfq, { supplier_name: name }))).response.bid_id);
      await new Promise((r) => setTimeout(r, 5));
    }

    const { response } = await call<{ bids: Bid[] }>((cb) => client.ListBids({ tenant_id: tenant, rfq_id: rfq }, cb));
    expect(response.bids.map((b) => b.bid_id)).toEqual(submitted.reverse());

    const other = await call<{ bids: Bid[] }>((cb) =>
      client.ListBids({ tenant_id: uniqueTenant(), rfq_id: rfq }, cb),
    );
    expect(other.response.bids).toEqual([]);
  });
});
