import { describe, expect, it } from 'vitest';
import { BID_ID_PATTERN, newBidId, slugify, supplierIdFor } from '../../src/domain/ids.js';
import { toRfc3339 } from '../../src/domain/time.js';

describe('newBidId', () => {
  it('is bid_ + 12 lowercase hex chars', () => {
    for (let i = 0; i < 100; i++) expect(newBidId()).toMatch(BID_ID_PATTERN);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 1_000 }, newBidId));
    expect(ids.size).toBe(1_000);
  });
});

describe('slugify / supplierIdFor', () => {
  it.each([
    ['Kestrel Fastening Co.', 'kestrel_fastening_co'],
    ['  ACME   Corp  ', 'acme_corp'],
    ['A & B -- Supplies', 'a_b_supplies'],
    ['Café Müller GmbH', 'cafe_muller_gmbh'],
    ['__Already_Slugged__', 'already_slugged'],
    ['Route 66 Parts', 'route_66_parts'],
    ['!!!', ''],
  ])('%j -> %j', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });

  it('prefixes supplier ids with sup_', () => {
    expect(supplierIdFor('Kestrel Fastening Co.')).toBe('sup_kestrel_fastening_co');
  });
});

describe('toRfc3339', () => {
  it('formats UTC with second precision', () => {
    expect(toRfc3339(new Date('2026-11-14T14:02:11.987Z'))).toBe('2026-11-14T14:02:11Z');
  });
});
