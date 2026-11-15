import snappy from 'snappyjs';
import { describe, expect, it } from 'vitest';
import { snappyDecompress } from '../../src/kafka-snappy.js';

describe('snappyDecompress', () => {
  const text = Buffer.from('{"event_type":"rfq.created"}'.repeat(20));

  it('decodes raw snappy blocks', () => {
    expect(snappyDecompress(snappy.compress(text))).toEqual(text);
  });

  it('decodes xerial-framed snappy (Java clients)', () => {
    const header = Buffer.from([0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00, 0, 0, 0, 1, 0, 0, 0, 1]);
    const chunk = (b: Buffer) => {
      const compressed = snappy.compress(b);
      const size = Buffer.alloc(4);
      size.writeUInt32BE(compressed.length);
      return Buffer.concat([size, compressed]);
    };
    const framed = Buffer.concat([header, chunk(text.subarray(0, 100)), chunk(text.subarray(100))]);
    expect(snappyDecompress(framed)).toEqual(text);
  });
});
