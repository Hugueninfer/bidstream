// JSON schemas for request validation, response serialization and the OpenAPI document.
// Shared shapes are registered with app.addSchema() and referenced by $ref in responses.

const nullable = (schema: Record<string, unknown>) => ({ ...schema, type: [schema.type as string, "null"] });

export const ErrorSchema = {
  $id: "Error",
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: { code: { type: "string" }, message: { type: "string" } },
    },
  },
} as const;

const priceEstimateProperties = {
  sku: { type: "string" },
  quantity: { type: "integer" },
  estimated_unit_price: { type: "number" },
  low: { type: "number" },
  high: { type: "number" },
  sample_size: { type: "integer" },
  cache_hit: { type: "boolean" },
  model_version: { type: "string" },
  latency_ms: { type: "number", description: "Round trip to pricing-service measured by the gateway" },
};

const priceEstimate = {
  type: "object",
  required: Object.keys(priceEstimateProperties),
  properties: priceEstimateProperties,
};

export const PriceEstimateSchema = { $id: "PriceEstimate", ...priceEstimate } as const;

export const RfqSchema = {
  $id: "Rfq",
  type: "object",
  required: [
    "rfq_id", "tenant_id", "title", "sku", "quantity", "unit", "deadline", "status", "created_at",
    "bid_count", "best_bid", "awarded", "estimate", "estimate_error",
  ],
  properties: {
    rfq_id: { type: "string", examples: ["rfq_7f3a91c2b0de"] },
    tenant_id: { type: "string" },
    title: { type: "string" },
    sku: { type: "string" },
    quantity: { type: "integer" },
    unit: { type: "string" },
    deadline: { type: "string", format: "date-time" },
    status: { type: "string", enum: ["open", "awarded", "expired"] },
    created_at: { type: "string", format: "date-time" },
    bid_count: { type: "integer" },
    best_bid: nullable({
      type: "object",
      required: ["unit_price", "supplier_name"],
      properties: { unit_price: { type: "number" }, supplier_name: { type: "string" } },
    }),
    awarded: nullable({
      type: "object",
      required: ["bid_id", "supplier_name", "unit_price", "awarded_at"],
      properties: {
        bid_id: { type: "string" },
        supplier_name: { type: "string" },
        unit_price: { type: "number" },
        awarded_at: { type: "string", format: "date-time" },
      },
    }),
    estimate: nullable(priceEstimate),
    estimate_error: {
      ...nullable({
        type: "object",
        required: ["code", "message"],
        properties: { code: { type: "string" }, message: { type: "string" } },
      }),
      description: "Set when estimate is null because pricing failed",
    },
  },
} as const;

export const BidSchema = {
  $id: "Bid",
  type: "object",
  required: [
    "bid_id", "rfq_id", "supplier_id", "supplier_name", "unit_price", "currency", "lead_time_days", "submitted_at",
  ],
  properties: {
    bid_id: { type: "string", examples: ["bid_0a1b2c3d4e5f"] },
    rfq_id: { type: "string" },
    supplier_id: { type: "string", examples: ["sup_kestrel_fastening_co"] },
    supplier_name: { type: "string" },
    unit_price: { type: "number" },
    currency: { type: "string", enum: ["USD"] },
    lead_time_days: { type: "integer" },
    submitted_at: { type: "string", format: "date-time" },
  },
} as const;

export const ServiceHealthSchema = {
  $id: "ServiceHealth",
  type: "object",
  required: ["name", "status", "p95_ms", "detail"],
  properties: {
    name: { type: "string", enum: ["rfq-service", "bid-service", "pricing-service"] },
    status: { type: "string", enum: ["healthy", "degraded", "down"] },
    p95_ms: { type: ["number", "null"], description: "Gateway-observed latency over the last 5 minutes" },
    detail: { type: ["string", "null"], examples: ["3 timeouts"] },
  },
} as const;

export const HealthSchema = {
  $id: "Health",
  type: "object",
  required: ["services", "checked_at"],
  properties: {
    services: { type: "array", items: { $ref: "ServiceHealth#" } },
    checked_at: { type: "string", format: "date-time" },
  },
} as const;

export const ActivityEventSchema = {
  $id: "ActivityEvent",
  type: "object",
  description: "Sent as `event: activity` on GET /v1/events",
  required: ["event_id", "topic", "event_type", "key", "occurred_at", "summary", "data"],
  properties: {
    event_id: { type: "string" },
    topic: { type: "string" },
    event_type: { type: "string", examples: ["bid.submitted"] },
    key: { type: "string" },
    occurred_at: { type: "string", format: "date-time" },
    summary: { type: "string", examples: ["Kestrel Fastening Co. $0.39"] },
    data: { type: "object", additionalProperties: true },
  },
} as const;

export const SHARED_SCHEMAS = [
  ErrorSchema,
  PriceEstimateSchema,
  RfqSchema,
  BidSchema,
  ServiceHealthSchema,
  HealthSchema,
  ActivityEventSchema,
];

export const ref = (id: string) => ({ $ref: `${id}#` });

/** Error responses, keyed by HTTP status. */
export const errors = (...statuses: number[]) =>
  Object.fromEntries(statuses.map((s) => [s, ref("Error")]));

export const rfqIdParams = {
  type: "object",
  required: ["rfqId"],
  properties: { rfqId: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

export const tenantHeaders = {
  type: "object",
  properties: {
    "x-tenant-id": {
      type: "string",
      pattern: "^[A-Za-z0-9_-]{1,64}$",
      description: "Tenant id (defaults to tenant_demo)",
    },
  },
} as const;
