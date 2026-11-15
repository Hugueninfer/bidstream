import { InvalidArgumentError } from './errors.js';
import { slugify, supplierIdFor } from './ids.js';

/** SubmitBid input after validation and normalization. */
export interface BidDraft {
  tenantId: string;
  rfqId: string;
  supplierId: string;
  supplierName: string;
  unitPrice: number;
  leadTimeDays: number;
  idempotencyKey: string | null;
}

export interface SubmitBidInput {
  tenant_id?: string;
  rfq_id?: string;
  supplier_id?: string;
  supplier_name?: string;
  unit_price?: number;
  lead_time_days?: number;
  idempotency_key?: string;
}

// NUMERIC(12,4): 8 integer digits and 4 decimals.
const PRICE_SCALE = 10_000;
const MAX_UNIT_PRICE = 99_999_999.9999;
const MAX_ID_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

function requiredId(value: string | undefined, field: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new InvalidArgumentError(`${field} is required`);
  if (trimmed.length > MAX_ID_LENGTH) throw new InvalidArgumentError(`${field} must be at most ${MAX_ID_LENGTH} characters`);
  return trimmed;
}

/** Rounds to the 4 decimals Postgres keeps, so the event carries the stored value. */
export function roundPrice(value: number): number {
  return Math.round(value * PRICE_SCALE) / PRICE_SCALE;
}

export function validateSubmitBid(input: SubmitBidInput): BidDraft {
  const tenantId = requiredId(input.tenant_id, 'tenant_id');
  const rfqId = requiredId(input.rfq_id, 'rfq_id');

  const supplierName = (input.supplier_name ?? '').trim();
  if (supplierName.length < 2 || supplierName.length > 120) {
    throw new InvalidArgumentError('supplier_name must be between 2 and 120 characters');
  }

  const rawPrice = input.unit_price;
  if (typeof rawPrice !== 'number' || !Number.isFinite(rawPrice) || rawPrice <= 0) {
    throw new InvalidArgumentError('unit_price must be a finite number greater than 0');
  }
  const unitPrice = roundPrice(rawPrice);
  if (unitPrice <= 0) throw new InvalidArgumentError('unit_price must be at least 0.0001');
  if (unitPrice > MAX_UNIT_PRICE) throw new InvalidArgumentError(`unit_price must be at most ${MAX_UNIT_PRICE}`);

  const leadTimeDays = input.lead_time_days;
  if (typeof leadTimeDays !== 'number' || !Number.isInteger(leadTimeDays) || leadTimeDays < 0 || leadTimeDays > 365) {
    throw new InvalidArgumentError('lead_time_days must be an integer between 0 and 365');
  }

  let supplierId = (input.supplier_id ?? '').trim();
  if (supplierId) {
    if (supplierId.length > MAX_ID_LENGTH) {
      throw new InvalidArgumentError(`supplier_id must be at most ${MAX_ID_LENGTH} characters`);
    }
  } else {
    if (!slugify(supplierName)) throw new InvalidArgumentError('supplier_name must contain letters or digits');
    supplierId = supplierIdFor(supplierName);
  }

  const idempotencyKey = (input.idempotency_key ?? '').trim() || null;
  if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new InvalidArgumentError(`idempotency_key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`);
  }

  return { tenantId, rfqId, supplierId, supplierName, unitPrice, leadTimeDays, idempotencyKey };
}
