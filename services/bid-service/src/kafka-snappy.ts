import kafkajs from 'kafkajs';
import snappy from 'snappyjs';

// kafkajs ships only gzip. Snappy matters because `rpk topic produce` (and
// other clients) compress with it by default, and a batch the consumer cannot
// decode crashes it before any DLQ logic can run.

// Java clients wrap snappy blocks in the xerial frame format:
// 8-byte magic, two 4-byte version fields, then (length, block) chunks.
const XERIAL_MAGIC = Buffer.from([0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00]);
const XERIAL_HEADER_LENGTH = 16;

export function snappyDecompress(buffer: Buffer): Buffer {
  if (!buffer.subarray(0, XERIAL_MAGIC.length).equals(XERIAL_MAGIC)) return snappy.uncompress(buffer);
  const chunks: Buffer[] = [];
  let offset = XERIAL_HEADER_LENGTH;
  while (offset + 4 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    offset += 4;
    chunks.push(snappy.uncompress(buffer.subarray(offset, offset + size)));
    offset += size;
  }
  return Buffer.concat(chunks);
}

export function registerSnappyCodec(): void {
  // kafkajs is CommonJS and these two are not detectable as named ESM exports.
  const { CompressionCodecs, CompressionTypes } = kafkajs;
  CompressionCodecs[CompressionTypes.Snappy] = () => ({
    compress: async (encoder: { buffer: Buffer }) => snappy.compress(encoder.buffer),
    decompress: async (buffer: Buffer) => snappyDecompress(buffer),
  });
}
