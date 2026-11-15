import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api, isApiError, newIdempotencyKey, toApiError } from "./client";

describe("toApiError", () => {
  it("parses the {error:{code,message}} envelope", () => {
    const e = toApiError(409, JSON.stringify({ error: { code: "rfq_syncing", message: "retry in a few seconds" } }));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
    expect(e.code).toBe("rfq_syncing");
    expect(e.message).toBe("retry in a few seconds");
    expect(e.retryable).toBe(false);
    expect(isApiError(e, "rfq_syncing")).toBe(true);
    expect(isApiError(e, "rfq_closed")).toBe(false);
  });

  it("falls back on non-JSON bodies", () => {
    const e = toApiError(502, "<html>Bad Gateway</html>");
    expect(e.code).toBe("upstream_unavailable");
    expect(e.retryable).toBe(true);
    expect(toApiError(404, "").code).toBe("not_found");
    expect(toApiError(418, "nope").code).toBe("http_418");
  });

  it("tolerates a malformed envelope", () => {
    expect(toApiError(400, JSON.stringify({ error: "bad" })).code).toBe("validation_error");
    expect(toApiError(503, JSON.stringify({ error: { code: "pricing_unavailable" } })).message).toBe(
      "pricing_unavailable",
    );
  });
});

describe("request", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the tenant and idempotency headers and returns the status", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ bid_id: "bid_1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await api.submitBid("rfq_7f3a91c2b0de", { supplier_name: "A", unit_price: 1, lead_time_days: 2 }, "k-1");
    expect(res.status).toBe(201);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v1/rfqs/rfq_7f3a91c2b0de/bids");
    const h = init.headers as Record<string, string>;
    expect(h["X-Tenant-Id"]).toBe("tenant_demo");
    expect(h["Idempotency-Key"]).toBe("k-1");
    expect(h["Content-Type"]).toBe("application/json");
    expect(init.method).toBe("POST");
  });

  it("throws a typed ApiError on error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "rfq_closed", message: "is awarded" } }), { status: 409 })),
    );
    await expect(api.getRfq("rfq_x")).rejects.toMatchObject({ status: 409, code: "rfq_closed" });
  });

  it("maps network failures to network_error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(api.skus()).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  it("builds the estimate query string", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await api.estimate("BOLT-M8", 40000);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/v1/estimate?sku=BOLT-M8&qty=40000");
  });
});

describe("newIdempotencyKey", () => {
  it("returns distinct v4 UUIDs", () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });
});
