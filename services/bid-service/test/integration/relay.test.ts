import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Producer } from 'kafkajs';
import type { Pool } from '../../src/db/pool.js';
import { BID_EVENTS_TOPIC, buildEnvelope } from '../../src/events/envelope.js';
import { enqueueEvent } from '../../src/events/outbox.js';
import { OutboxRelay } from '../../src/events/relay.js';
import { createKafka, createProducer } from '../../src/kafka.js';
import { cleanupTenant, rfqId, setupDatabase, silentLogger, uniqueTenant } from './helpers.js';

// Publishes to the real Redpanda (KAFKA_BROKERS, default localhost:19092): the
// relay drains *every* unpublished row, so faking the producer could silently
// drop someone else's events from a shared database.
const brokers = (process.env.KAFKA_BROKERS ?? 'localhost:19092').split(',');

let pool: Pool;
let producer: Producer;
const tenant = uniqueTenant();

beforeAll(async () => {
  pool = await setupDatabase();
  producer = createProducer(createKafka(brokers, silentLogger));
  await producer.connect();
});

afterAll(async () => {
  await producer?.disconnect();
  if (pool) {
    await cleanupTenant(pool, tenant);
    await pool.end();
  }
});

describe('OutboxRelay', () => {
  it('publishes pending rows and marks them published', async () => {
    const rfq = rfqId();
    const envelopes = [1, 2, 3].map((n) =>
      buildEnvelope({ eventType: 'bid.submitted', tenantId: tenant, key: rfq, data: { n } }),
    );
    for (const envelope of envelopes) await enqueueEvent(pool, { topic: BID_EVENTS_TOPIC, envelope });

    const relay = new OutboxRelay(pool, producer, silentLogger, { batchSize: 100 });
    while ((await relay.relayBatch()) > 0) {
      // drain everything pending, ours included
    }

    const { rows } = await pool.query(
      'SELECT published_at FROM outbox WHERE event_id = ANY($1::uuid[])',
      [envelopes.map((e) => e.event_id)],
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.published_at).toBeInstanceOf(Date);
  });

  it('runs and stops cleanly', async () => {
    const relay = new OutboxRelay(pool, producer, silentLogger, { pollIntervalMs: 20 });
    relay.start();
    await new Promise((r) => setTimeout(r, 100));
    await relay.stop();
  });
});
