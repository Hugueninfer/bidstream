import { describe, expect, it } from 'vitest';
import {
  buildEnvelope,
  parseEnvelope,
  PermanentEventError,
  readInteger,
  readTimestamp,
} from '../../src/events/envelope.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('buildEnvelope', () => {
  it('builds a v1 envelope keyed by the RFQ', () => {
    const envelope = buildEnvelope({
      eventType: 'bid.submitted',
      tenantId: 'tenant_demo',
      key: 'rfq_7f3a91c2b0de',
      data: { bid_id: 'bid_000000000001' },
      occurredAt: new Date('2026-11-14T14:02:11.500Z'),
    });
    expect(envelope).toEqual({
      event_id: expect.stringMatching(UUID_V4),
      event_type: 'bid.submitted',
      version: 1,
      occurred_at: '2026-11-14T14:02:11Z',
      tenant_id: 'tenant_demo',
      key: 'rfq_7f3a91c2b0de',
      data: { bid_id: 'bid_000000000001' },
    });
  });

  it('generates a fresh event_id each time', () => {
    const args = { eventType: 'x', tenantId: 't', key: 'k', data: {} };
    expect(buildEnvelope(args).event_id).not.toBe(buildEnvelope(args).event_id);
  });
});

describe('parseEnvelope', () => {
  const envelope = buildEnvelope({
    eventType: 'rfq.created',
    tenantId: 'tenant_demo',
    key: 'rfq_1',
    data: { rfq_id: 'rfq_1' },
  });

  it('round-trips an envelope', () => {
    expect(parseEnvelope(Buffer.from(JSON.stringify(envelope)))).toEqual(envelope);
  });

  it.each([
    ['null value', null],
    ['invalid JSON', '{nope'],
    ['an array', '[]'],
    ['a non-uuid event_id', JSON.stringify({ ...envelope, event_id: 'abc' })],
    ['a missing event_type', JSON.stringify({ ...envelope, event_type: '' })],
    ['a missing tenant_id', JSON.stringify({ ...envelope, tenant_id: undefined })],
    ['non-object data', JSON.stringify({ ...envelope, data: 'x' })],
  ])('rejects %s as permanent', (_label, raw) => {
    expect(() => parseEnvelope(raw)).toThrowError(PermanentEventError);
  });
});

describe('data readers', () => {
  it('reads int64 quantities sent as numbers or strings', () => {
    expect(readInteger({ quantity: 15000 }, 'quantity')).toBe(15000);
    expect(readInteger({ quantity: '15000' }, 'quantity')).toBe(15000);
    expect(() => readInteger({ quantity: 1.5 }, 'quantity')).toThrowError(PermanentEventError);
    expect(() => readInteger({}, 'quantity')).toThrowError(PermanentEventError);
  });

  it('reads RFC 3339 timestamps', () => {
    expect(readTimestamp({ deadline: '2026-11-16T17:00:00Z' }, 'deadline').toISOString()).toBe(
      '2026-11-16T17:00:00.000Z',
    );
    expect(() => readTimestamp({ deadline: 'tomorrow' }, 'deadline')).toThrowError(PermanentEventError);
  });
});
