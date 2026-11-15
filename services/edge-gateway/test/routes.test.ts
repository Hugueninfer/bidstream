import { status } from "@grpc/grpc-js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeApp, protoBid, protoRfq, upstreamError, type FakeBid, type FakePricing, type FakeRfq } from "./fakes.js";

let app: FastifyInstance;
let rfq: FakeRfq;
let bid: FakeBid;
let pricing: FakePricing;

beforeEach(async () => {
  ({ app, rfq, bid, pricing } = await makeApp());
});
afterEach(() => app.close());

describe("GET /v1/rfqs", () => {
  beforeEach(() => {
    rfq.rfqs = [
      protoRfq({ rfq_id: "rfq_a", sku: "BOLT-M8", quantity: 40000, created_at: "2026-11-14T10:00:00Z" }),
      protoRfq({ rfq_id: "rfq_b", sku: "NUT-M8", quantity: 60000, created_at: "2026-11-14T12:00:00Z" }),
      protoRfq({ rfq_id: "rfq_c", sku: "BOLT-M8", quantity: 40000, created_at: "2026-11-14T11:00:00Z", status: "awarded" }),
      protoRfq({ rfq_id: "rfq_d", sku: "PALLET-WOOD", quantity: 800, created_at: "2026-11-13T11:00:00Z", status: "expired" }),
    ];
  });

  it("returns newest first with counts and per-RFQ estimates; a failing estimate does not fail the list", async () => {
    pricing.failures.set("NUT-M8", upstreamError("pricing-service", status.DEADLINE_EXCEEDED));
    const res = await app.inject({ method: "GET", url: "/v1/rfqs" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.counts).toEqual({ all: 4, open: 2, awarded: 1, expired: 1 });
    expect(body.rfqs.map((r: { rfq_id: string }) => r.rfq_id)).toEqual(["rfq_b", "rfq_c", "rfq_a", "rfq_d"]);

    const [b, c, a] = body.rfqs;
    expect(b.estimate).toBeNull();
    expect(b.estimate_error).toEqual({ code: "pricing_unavailable", message: "pricing-service timed out" });
    expect(a.estimate).toMatchObject({ sku: "BOLT-M8", quantity: 40000, latency_ms: 12, cache_hit: false });
    expect(a.estimate_error).toBeNull();
    expect(c.estimate).toEqual(a.estimate);
    expect(a.best_bid).toBeNull();
    // One pricing call per distinct (sku, quantity).
    expect(pricing.calls.sort()).toEqual(["BOLT-M8:40000", "NUT-M8:60000", "PALLET-WOOD:800"]);
  });

  it("filters by status in the gateway but counts everything", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/rfqs?status=open" });
    expect(res.statusCode).toBe(200);
    expect(res.json().rfqs.map((r: { rfq_id: string }) => r.rfq_id)).toEqual(["rfq_b", "rfq_a"]);
    expect(res.json().counts.all).toBe(4);
    expect(rfq.calls).toEqual(["ListRfqs:"]);
  });

  it("rejects an unknown status filter", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/rfqs?status=pending" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("uses the X-Tenant-Id header", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/rfqs", headers: { "x-tenant-id": "tenant_other" } });
    expect(res.json()).toEqual({ rfqs: [], counts: { all: 0, open: 0, awarded: 0, expired: 0 } });
  });

  it("returns 503 upstream_unavailable when rfq-service is down", async () => {
    rfq.error = upstreamError("rfq-service", status.UNAVAILABLE, "connect ECONNREFUSED");
    const res = await app.inject({ method: "GET", url: "/v1/rfqs" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: "upstream_unavailable", message: "rfq-service is unavailable" } });
  });
});

describe("GET /v1/rfqs/:rfqId", () => {
  it("returns the RFQ with its estimate", async () => {
    rfq.rfqs = [protoRfq({ best_bid_unit_price: 0.41, best_bid_supplier_name: "Kestrel" })];
    const res = await app.inject({ method: "GET", url: "/v1/rfqs/rfq_000000000001" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      rfq_id: "rfq_000000000001",
      best_bid: { unit_price: 0.41, supplier_name: "Kestrel" },
      awarded: null,
      estimate: { sku: "BOLT-M8" },
      estimate_error: null,
    });
  });

  it("returns 404 not_found for an unknown RFQ", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/rfqs/rfq_missing" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "rfq rfq_missing not found" } });
  });
});

describe("POST /v1/rfqs", () => {
  const valid = { title: "Bolts", sku: "BOLT-M8", quantity: 40000, unit: "pcs", deadline: "2026-12-01T17:00:00Z" };

  it("creates an RFQ (201)", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/rfqs", payload: valid });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ rfq_id: "rfq_00000000000f", sku: "BOLT-M8", estimate: { sku: "BOLT-M8" } });
  });

  it.each([
    ["missing field", { ...valid, title: undefined }],
    ["string quantity", { ...valid, quantity: "40000" }],
    ["fractional quantity", { ...valid, quantity: 1.5 }],
    ["zero quantity", { ...valid, quantity: 0 }],
    ["bad deadline", { ...valid, deadline: "next friday" }],
  ])("rejects %s with 400 validation_error", async (_name, payload) => {
    const res = await app.inject({ method: "POST", url: "/v1/rfqs", payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
    expect(typeof res.json().error.message).toBe("string");
  });

  it("rejects malformed JSON with the error envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/rfqs",
      headers: { "content-type": "application/json" },
      payload: "{nope",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("surfaces INVALID_ARGUMENT from rfq-service as 400", async () => {
    rfq.error = upstreamError("rfq-service", status.INVALID_ARGUMENT, "deadline must be in the future");
    const res = await app.inject({ method: "POST", url: "/v1/rfqs", payload: valid });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: "validation_error", message: "deadline must be in the future" } });
  });
});

describe("POST /v1/rfqs/:rfqId/bids", () => {
  const payload = { supplier_name: "Kestrel Fastening Co.", unit_price: 0.39, lead_time_days: 7 };
  const submit = (headers: Record<string, string> = {}, body: object = payload, id = "rfq_000000000001") =>
    app.inject({ method: "POST", url: `/v1/rfqs/${id}/bids`, payload: body, headers });

  beforeEach(() => {
    rfq.rfqs = [protoRfq()];
  });

  it("returns 201 for a new bid and forwards the idempotency key and derived supplier id", async () => {
    const res = await submit({ "idempotency-key": "abc-123" });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ bid_id: "bid_00000000000a", supplier_name: "Kestrel Fastening Co.", currency: "USD" });
    expect(bid.lastInput).toMatchObject({
      tenant_id: "tenant_demo",
      rfq_id: "rfq_000000000001",
      supplier_id: "sup_kestrel_fastening_co",
      idempotency_key: "abc-123",
    });
  });

  it("returns 200 on idempotent replay", async () => {
    bid.replay = true;
    const res = await submit({ "idempotency-key": "abc-123" });
    expect(res.statusCode).toBe(200);
    expect(res.json().bid_id).toBe("bid_00000000000a");
  });

  it("returns 409 rfq_syncing when bid-service does not know the RFQ yet", async () => {
    bid.error = upstreamError("bid-service", status.NOT_FOUND, "rfq unknown");
    const res = await submit();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("rfq_syncing");
    expect(res.json().error.message).toMatch(/retry in a few seconds/);
  });

  it("returns 409 rfq_closed when the RFQ is not open (checked before bid-service)", async () => {
    rfq.rfqs = [protoRfq({ status: "awarded" })];
    const res = await submit();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("rfq_closed");
    expect(bid.lastInput).toBeNull();
  });

  it("returns 409 rfq_closed when bid-service says FAILED_PRECONDITION", async () => {
    bid.error = upstreamError("bid-service", status.FAILED_PRECONDITION, "rfq is past its deadline");
    const res = await submit();
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: "rfq_closed", message: "rfq is past its deadline" } });
  });

  it("returns 404 for an unknown RFQ", async () => {
    const res = await submit({}, payload, "rfq_missing");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
    expect(bid.lastInput).toBeNull();
  });

  it.each([
    ["negative price", { ...payload, unit_price: -1 }],
    ["zero price", { ...payload, unit_price: 0 }],
    ["missing supplier", { unit_price: 1, lead_time_days: 2 }],
    ["fractional lead time", { ...payload, lead_time_days: 2.5 }],
    ["bad supplier_id", { ...payload, supplier_id: "Kestrel" }],
  ])("rejects %s with 400", async (_name, body) => {
    const res = await submit({}, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("returns 503 upstream_unavailable when bid-service is down", async () => {
    bid.error = upstreamError("bid-service", status.UNAVAILABLE);
    const res = await submit();
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("upstream_unavailable");
  });
});

describe("GET /v1/rfqs/:rfqId/bids", () => {
  it("lists bids newest first", async () => {
    rfq.rfqs = [protoRfq()];
    bid.bids = [
      protoBid({ bid_id: "bid_old", submitted_at: "2026-11-14T10:00:00Z" }),
      protoBid({ bid_id: "bid_new", submitted_at: "2026-11-14T11:00:00Z" }),
    ];
    const res = await app.inject({ method: "GET", url: "/v1/rfqs/rfq_000000000001/bids" });
    expect(res.statusCode).toBe(200);
    expect(res.json().bids.map((b: { bid_id: string }) => b.bid_id)).toEqual(["bid_new", "bid_old"]);
  });

  it("404s for an unknown RFQ", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/rfqs/rfq_missing/bids" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /v1/rfqs/:rfqId/award", () => {
  beforeEach(() => {
    rfq.rfqs = [protoRfq()];
  });

  it("returns the awarded RFQ", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/rfqs/rfq_000000000001/award", payload: { bid_id: "bid_1" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "awarded", awarded: { bid_id: "bid_1", unit_price: 0.39 } });
  });

  it("returns 409 rfq_closed with the upstream message on conflict", async () => {
    rfq.awardError = upstreamError("rfq-service", status.FAILED_PRECONDITION, "RFQ rfq_000000000001 is already awarded");
    const res = await app.inject({ method: "POST", url: "/v1/rfqs/rfq_000000000001/award", payload: { bid_id: "bid_2" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: "rfq_closed", message: "RFQ rfq_000000000001 is already awarded" },
    });
  });

  it("requires bid_id", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/rfqs/rfq_000000000001/award", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });
});

describe("catalog", () => {
  it("serves the static SKU list", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/skus" });
    expect(res.json().skus).toHaveLength(6);
    expect(res.json().skus[0]).toEqual({ sku: "BOLT-M8", unit: "pcs" });
  });

  it("returns an estimate with coerced qty", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/estimate?sku=NUT-M8&qty=60000" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      sku: "NUT-M8",
      quantity: 60000,
      estimated_unit_price: 0.47,
      low: 0.41,
      high: 0.53,
      sample_size: 1100,
      cache_hit: false,
      model_version: "v1",
      latency_ms: 12,
    });
  });

  it.each([
    ["missing qty", "/v1/estimate?sku=NUT-M8"],
    ["non-numeric qty", "/v1/estimate?sku=NUT-M8&qty=lots"],
    ["zero qty", "/v1/estimate?sku=NUT-M8&qty=0"],
  ])("rejects %s", async (_name, url) => {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("maps pricing failures", async () => {
    pricing.failures.set("NUT-M8", upstreamError("pricing-service", status.UNAVAILABLE));
    pricing.failures.set("UNOBTANIUM", upstreamError("pricing-service", status.NOT_FOUND, "no history for SKU UNOBTANIUM"));
    const down = await app.inject({ method: "GET", url: "/v1/estimate?sku=NUT-M8&qty=1" });
    expect(down.statusCode).toBe(503);
    expect(down.json().error.code).toBe("pricing_unavailable");
    const unknown = await app.inject({ method: "GET", url: "/v1/estimate?sku=UNOBTANIUM&qty=1" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe("not_found");
  });
});

describe("health endpoints", () => {
  it("serves /v1/health, /healthz and /readyz", async () => {
    const health = await app.inject({ method: "GET", url: "/v1/health" });
    expect(health.json().services).toHaveLength(3);
    expect(health.json().checked_at).toBe("2026-11-14T12:00:00Z");
    expect((await app.inject({ method: "GET", url: "/healthz" })).json()).toEqual({ status: "ok" });
    expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
  });

  it("reports not ready when a channel is down", async () => {
    const made = await makeApp();
    made.health.ready = false;
    const res = await made.app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: "not_ready", channels: { "rfq-service": false } });
    await made.app.close();
  });
});

describe("cross-cutting", () => {
  it("answers unknown routes with the error envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("applies CORS for allowed origins only", async () => {
    const ok = await app.inject({ method: "GET", url: "/v1/skus", headers: { origin: "http://localhost:5173" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const other = await app.inject({ method: "GET", url: "/v1/skus", headers: { origin: "http://evil.test" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/rfqs/rfq_1/bids",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,idempotency-key,x-tenant-id",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-headers"]).toMatch(/Idempotency-Key/);
  });

  it("serves an OpenAPI document covering every endpoint", async () => {
    const res = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        "/healthz",
        "/readyz",
        "/v1/estimate",
        "/v1/events",
        "/v1/health",
        "/v1/rfqs",
        "/v1/rfqs/{rfqId}",
        "/v1/rfqs/{rfqId}/award",
        "/v1/rfqs/{rfqId}/bids",
        "/v1/skus",
      ].sort(),
    );
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(["Rfq", "Bid", "PriceEstimate", "Error", "ServiceHealth", "ActivityEvent"]),
    );
  });
});
