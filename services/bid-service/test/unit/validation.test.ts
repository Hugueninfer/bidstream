import { describe, expect, it } from 'vitest';
import { InvalidArgumentError } from '../../src/domain/errors.js';
import { roundPrice, validateSubmitBid, type SubmitBidInput } from '../../src/domain/validation.js';

const valid: SubmitBidInput = {
  tenant_id: 'tenant_demo',
  rfq_id: 'rfq_7f3a91c2b0de',
  supplier_name: 'Kestrel Fastening Co.',
  unit_price: 0.39,
  lead_time_days: 14,
};

function expectInvalid(input: SubmitBidInput, message: RegExp): void {
  expect(() => validateSubmitBid(input)).toThrowError(InvalidArgumentError);
  expect(() => validateSubmitBid(input)).toThrowError(message);
}

describe('validateSubmitBid', () => {
  it('normalizes a valid request', () => {
    expect(validateSubmitBid({ ...valid, supplier_name: '  Kestrel Fastening Co.  ' })).toEqual({
      tenantId: 'tenant_demo',
      rfqId: 'rfq_7f3a91c2b0de',
      supplierId: 'sup_kestrel_fastening_co',
      supplierName: 'Kestrel Fastening Co.',
      unitPrice: 0.39,
      leadTimeDays: 14,
      idempotencyKey: null,
    });
  });

  it('keeps an explicit supplier_id and idempotency key', () => {
    const draft = validateSubmitBid({ ...valid, supplier_id: 'sup_custom', idempotency_key: ' key-1 ' });
    expect(draft.supplierId).toBe('sup_custom');
    expect(draft.idempotencyKey).toBe('key-1');
  });

  it('treats proto3 defaults (empty strings) as missing', () => {
    expectInvalid({ ...valid, tenant_id: '' }, /tenant_id is required/);
    expectInvalid({ ...valid, rfq_id: '   ' }, /rfq_id is required/);
    expect(validateSubmitBid({ ...valid, idempotency_key: '' }).idempotencyKey).toBeNull();
  });

  it.each([
    ['too short', 'K'],
    ['blank', '   '],
    ['too long', 'x'.repeat(121)],
  ])('rejects a supplier_name that is %s', (_label, supplier_name) => {
    expectInvalid({ ...valid, supplier_name }, /supplier_name must be between 2 and 120/);
  });

  it('accepts supplier_name at both length bounds', () => {
    expect(validateSubmitBid({ ...valid, supplier_name: 'AB' }).supplierName).toBe('AB');
    expect(validateSubmitBid({ ...valid, supplier_name: 'a'.repeat(120) }).supplierName).toHaveLength(120);
  });

  it('rejects a supplier_name without any letter or digit when no supplier_id is given', () => {
    expectInvalid({ ...valid, supplier_name: '!!!' }, /letters or digits/);
    expect(validateSubmitBid({ ...valid, supplier_name: '!!!', supplier_id: 'sup_x' }).supplierId).toBe('sup_x');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects unit_price %s',
    (unit_price) => expectInvalid({ ...valid, unit_price }, /unit_price/),
  );

  it('rejects prices that round to zero or overflow NUMERIC(12,4)', () => {
    expectInvalid({ ...valid, unit_price: 0.00001 }, /at least 0.0001/);
    expectInvalid({ ...valid, unit_price: 1e8 }, /at most/);
  });

  it('rounds unit_price to 4 decimals like Postgres', () => {
    expect(validateSubmitBid({ ...valid, unit_price: 0.123456 }).unitPrice).toBe(0.1235);
    expect(roundPrice(46.2)).toBe(46.2);
  });

  it.each([-1, 366, 1.5, Number.NaN])('rejects lead_time_days %s', (lead_time_days) => {
    expectInvalid({ ...valid, lead_time_days }, /lead_time_days must be an integer between 0 and 365/);
  });

  it('accepts lead_time_days at both bounds', () => {
    expect(validateSubmitBid({ ...valid, lead_time_days: 0 }).leadTimeDays).toBe(0);
    expect(validateSubmitBid({ ...valid, lead_time_days: 365 }).leadTimeDays).toBe(365);
  });

  it('rejects oversized identifiers', () => {
    expectInvalid({ ...valid, idempotency_key: 'k'.repeat(201) }, /idempotency_key/);
    expectInvalid({ ...valid, supplier_id: 's'.repeat(129) }, /supplier_id/);
  });
});
