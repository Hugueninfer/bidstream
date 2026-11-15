import { randomBytes } from 'node:crypto';

export const BID_ID_PATTERN = /^bid_[0-9a-f]{12}$/;

/** `bid_` + 12 lowercase hex chars, e.g. `bid_7f3a91c2b0de`. */
export function newBidId(): string {
  return `bid_${randomBytes(6).toString('hex')}`;
}

/**
 * Lowercase ASCII slug: accents are folded ("Café" -> "cafe"), every run of
 * other characters becomes a single `_`, and leading/trailing `_` are trimmed.
 */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** `sup_` + slug of the supplier name, e.g. `sup_kestrel_fastening_co`. */
export function supplierIdFor(supplierName: string): string {
  return `sup_${slugify(supplierName)}`;
}
