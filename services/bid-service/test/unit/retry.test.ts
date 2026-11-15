import { describe, expect, it, vi } from 'vitest';
import type { KafkaMessage } from 'kafkajs';
import { buildDlqMessage } from '../../src/events/consumer.js';
import { PermanentEventError } from '../../src/events/envelope.js';
import { RETRY_DELAYS_MS, withRetries } from '../../src/events/retry.js';

describe('withRetries', () => {
  it('uses the contract backoff: 200 ms, 1 s, 3 s, then gives up', async () => {
    const waits: number[] = [];
    const fn = vi.fn().mockRejectedValue(new Error('db down'));
    const result = await withRetries(fn, { wait: async (ms) => waits.push(ms) });
    expect(RETRY_DELAYS_MS).toEqual([200, 1_000, 3_000]);
    expect(waits).toEqual([200, 1_000, 3_000]);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({ ok: false, attempts: 4 });
  });

  it('returns as soon as an attempt succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValue('applied');
    const onRetry = vi.fn();
    const result = await withRetries(fn, { wait: async () => {}, onRetry });
    expect(result).toEqual({ ok: true, value: 'applied', attempts: 2 });
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1, 200);
  });

  it('does not retry permanent errors', async () => {
    const fn = vi.fn().mockRejectedValue(new PermanentEventError('bad json'));
    const result = await withRetries(fn, { wait: async () => {} });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, attempts: 1 });
  });
});

describe('buildDlqMessage', () => {
  it('keeps the original key, value and headers and adds the failure context', () => {
    const message = {
      key: Buffer.from('rfq_1'),
      value: Buffer.from('{nope'),
      headers: { event_type: Buffer.from('rfq.created') },
      offset: '42',
    } as unknown as KafkaMessage;
    const dlq = buildDlqMessage({ topic: 'rfq.events', partition: 2, message }, new PermanentEventError('not JSON'));
    expect(dlq.key).toBe(message.key);
    expect(dlq.value).toBe(message.value);
    expect(dlq.headers).toEqual({
      event_type: message.headers!.event_type,
      dlq_error: 'PermanentEventError: not JSON',
      dlq_consumer: 'bid-service',
      dlq_topic: 'rfq.events',
      dlq_partition: '2',
      dlq_offset: '42',
    });
  });
});
