import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from '../../src/db/pool.js';
import { buildEnvelope, PermanentEventError, type EventEnvelope } from '../../src/events/envelope.js';
import { handleRfqEvent } from '../../src/events/rfq-handler.js';
import { cleanupTenant, rfqId, setupDatabase, uniqueTenant } from './helpers.js';

let pool: Pool;
const tenant = uniqueTenant();
const otherTenant = uniqueTenant();
const eventIds: string[] = [];

beforeAll(async () => {
  pool = await setupDatabase();
});

afterAll(async () => {
  if (!pool) return;
  await cleanupTenant(pool, tenant, eventIds);
  await cleanupTenant(pool, otherTenant);
  await pool.end();
});

function event(eventType: string, data: Record<string, unknown>, tenantId = tenant): EventEnvelope {
  const envelope = buildEnvelope({ eventType, tenantId, key: String(data.rfq_id), data: { tenant_id: tenantId, ...data } });
  eventIds.push(envelope.event_id);
  return envelope;
}

const created = (rfq: string, tenantId = tenant) =>
  event(
    'rfq.created',
    {
      rfq_id: rfq,
      title: 'M8 bolts',
      sku: 'BOLT-M8',
      quantity: 40000,
      unit: 'pcs',
      deadline: '2030-01-01T00:00:00Z',
      created_at: '2026-11-14T14:00:00Z',
    },
    tenantId,
  );

const awarded = (rfq: string) =>
  event('rfq.awarded', {
    rfq_id: rfq,
    sku: 'BOLT-M8',
    quantity: '40000', // int64 serialized as a string must work too
    bid_id: 'bid_000000000001',
    supplier_id: 'sup_kestrel',
    supplier_name: 'Kestrel',
    unit_price: 0.39,
    awarded_at: '2026-11-15T10:00:00Z',
  });

async function view(rfq: string) {
  const { rows } = await pool.query(
    'SELECT tenant_id, status, deadline, quantity FROM rfq_view WHERE rfq_id = $1',
    [rfq],
  );
  return rows[0];
}

describe('handleRfqEvent', () => {
  it('applies rfq.created once and skips the redelivery', async () => {
    const rfq = rfqId();
    const envelope = created(rfq);

    expect(await handleRfqEvent(pool, envelope)).toBe('applied');
    expect(await handleRfqEvent(pool, envelope)).toBe('duplicate');

    expect(await view(rfq)).toEqual({
      tenant_id: tenant,
      status: 'open',
      deadline: new Date('2030-01-01T00:00:00Z'),
      quantity: '40000',
    });
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM processed_events WHERE event_id = $1 AND consumer = 'bid-service'`,
      [envelope.event_id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('marks the RFQ awarded, idempotently', async () => {
    const rfq = rfqId();
    await handleRfqEvent(pool, created(rfq));
    const award = awarded(rfq);

    expect(await handleRfqEvent(pool, award)).toBe('applied');
    expect(await handleRfqEvent(pool, award)).toBe('duplicate');
    expect((await view(rfq)).status).toBe('awarded');
  });

  it('never reopens an awarded RFQ when rfq.created arrives late', async () => {
    const rfq = rfqId();
    expect(await handleRfqEvent(pool, awarded(rfq))).toBe('applied');
    expect((await view(rfq)).status).toBe('awarded');

    expect(await handleRfqEvent(pool, created(rfq))).toBe('applied');
    expect(await view(rfq)).toMatchObject({ status: 'awarded', deadline: new Date('2030-01-01T00:00:00Z') });
  });

  it('ignores unknown event types without recording them', async () => {
    const envelope = event('rfq.renamed', { rfq_id: rfqId() });
    expect(await handleRfqEvent(pool, envelope)).toBe('ignored');
    const { rows } = await pool.query('SELECT 1 FROM processed_events WHERE event_id = $1', [envelope.event_id]);
    expect(rows).toHaveLength(0);
  });

  it('rejects malformed data as permanent and rolls back the dedupe marker', async () => {
    const envelope = event('rfq.created', { rfq_id: rfqId(), quantity: 10, deadline: 'soon' });
    await expect(handleRfqEvent(pool, envelope)).rejects.toThrowError(PermanentEventError);
    const { rows } = await pool.query('SELECT 1 FROM processed_events WHERE event_id = $1', [envelope.event_id]);
    expect(rows).toHaveLength(0);
  });

  it('refuses to move an RFQ to another tenant', async () => {
    const rfq = rfqId();
    await handleRfqEvent(pool, created(rfq));
    await expect(handleRfqEvent(pool, created(rfq, otherTenant))).rejects.toThrowError(/another tenant/);
    expect((await view(rfq)).tenant_id).toBe(tenant);
  });
});
