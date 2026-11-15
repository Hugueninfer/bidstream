// Exercises the real gRPC client layer against in-process fake servers built
// from the repo's protos: decoding, metadata, deadlines, health probes.
import * as grpc from "@grpc/grpc-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGrpcUpstreams, type GrpcUpstreams } from "../src/clients/grpc-clients.js";
import { UpstreamError } from "../src/clients/errors.js";
import { loadServices } from "../src/clients/proto.js";
import { resolveProtoDir } from "../src/config.js";
import { toRestRfq } from "../src/mapping.js";

const services = loadServices(resolveProtoDir({}));

const baseRfq = {
  rfq_id: "rfq_plain",
  tenant_id: "tenant_demo",
  title: "Bolts",
  sku: "BOLT-M8",
  quantity: 40000,
  unit: "pcs",
  deadline: "2026-11-20T17:00:00Z",
  status: "open",
  created_at: "2026-11-14T10:00:00Z",
  bid_count: 0,
};

type Handler = (call: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) => void;

let server: grpc.Server;
let port: number;
let upstreams: GrpcUpstreams;
let unreachable: GrpcUpstreams;

beforeAll(async () => {
  server = new grpc.Server();
  const rfq: Record<string, Handler> = {
    GetRfq: (call, cb) => {
      if (call.request.rfq_id === "rfq_plain") return cb(null, baseRfq);
      if (call.request.rfq_id === "rfq_awarded") {
        return cb(null, {
          ...baseRfq,
          rfq_id: "rfq_awarded",
          status: "awarded",
          bid_count: 2,
          best_bid_unit_price: 0,
          best_bid_supplier_name: "Zero Co",
          awarded_bid_id: "bid_1",
          awarded_supplier_name: "Zero Co",
          awarded_unit_price: 0,
          awarded_at: "2026-11-15T00:00:00Z",
        });
      }
      cb({ code: grpc.status.NOT_FOUND, details: `rfq ${call.request.rfq_id} not found` });
    },
    ListRfqs: (_call, cb) => cb(null, { rfqs: [baseRfq] }),
    CreateRfq: (_call, cb) => cb({ code: grpc.status.INVALID_ARGUMENT, details: "bad sku" }),
    AwardRfq: (_call, cb) => cb({ code: grpc.status.FAILED_PRECONDITION, details: "already awarded" }),
  };
  const bid = {
    SubmitBid: (call: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) => {
      const res = { ...call.request, bid_id: "bid_x", currency: "USD", submitted_at: "2026-11-14T11:00:00Z" };
      const md = new grpc.Metadata();
      md.set("x-idempotent-replay", "true");
      if (call.request.idempotency_key === "replay-initial") {
        call.sendMetadata(md);
        return cb(null, res);
      }
      if (call.request.idempotency_key === "replay-trailer") return cb(null, res, md);
      cb(null, res);
    },
    GetBid: (_call: unknown, cb: grpc.sendUnaryData<any>) => cb({ code: grpc.status.UNIMPLEMENTED }),
    ListBids: (_call: unknown, cb: grpc.sendUnaryData<any>) => cb(null, { bids: [] }),
  };
  const pricing = {
    GetPriceEstimate: (call: grpc.ServerUnaryCall<any, any>, cb: grpc.sendUnaryData<any>) => {
      const reply = () =>
        cb(null, {
          sku: call.request.sku,
          quantity: call.request.quantity,
          estimated_unit_price: 0.47,
          low: 0.4,
          high: 0.55,
          sample_size: 1200,
          cache_hit: true,
          model_version: "v1",
        });
      if (call.request.sku === "SLOW") setTimeout(reply, 1_500);
      else reply();
    },
  };
  server.addService(services.RfqService.service, rfq);
  server.addService(services.BidService.service, bid);
  server.addService(services.PricingService.service, pricing);
  server.addService(services.Health.service, {
    Check: (_call: unknown, cb: grpc.sendUnaryData<any>) => cb(null, { status: "SERVING" }),
  });
  port = await new Promise<number>((resolve, reject) =>
    server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
  );

  const addr = `127.0.0.1:${port}`;
  upstreams = createGrpcUpstreams({ rfq: addr, bid: addr, pricing: addr }, services);
  // Port 1 on localhost: connection refused.
  unreachable = createGrpcUpstreams({ rfq: "127.0.0.1:1", bid: "127.0.0.1:1", pricing: "127.0.0.1:1" }, services);
});

afterAll(() => {
  upstreams?.close();
  unreachable?.close();
  server?.forceShutdown();
});

describe("gRPC clients against a fake server", () => {
  it("decodes unset proto3 optional fields as absent, not as defaults", async () => {
    const rfq = await upstreams.upstreams.rfq.getRfq("tenant_demo", "rfq_plain");
    expect(rfq.best_bid_unit_price).toBeUndefined();
    expect(rfq.awarded_bid_id).toBeUndefined();
    expect(rfq.quantity).toBe(40000);
    expect(typeof rfq.quantity).toBe("number");
    const rest = toRestRfq(rfq);
    expect(rest.best_bid).toBeNull();
    expect(rest.awarded).toBeNull();
  });

  it("keeps explicitly set optional zero values", async () => {
    const rest = toRestRfq(await upstreams.upstreams.rfq.getRfq("tenant_demo", "rfq_awarded"));
    expect(rest.best_bid).toEqual({ unit_price: 0, supplier_name: "Zero Co" });
    expect(rest.awarded).toMatchObject({ bid_id: "bid_1", unit_price: 0 });
  });

  it("raises UpstreamError with the gRPC status", async () => {
    const err = await upstreams.upstreams.rfq.getRfq("tenant_demo", "rfq_nope").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).toMatchObject({ service: "rfq-service", code: grpc.status.NOT_FOUND, details: "rfq rfq_nope not found" });
  });

  it.each([
    ["", false],
    ["replay-initial", true],
    ["replay-trailer", true],
  ])("detects x-idempotent-replay (key %j → %s)", async (key, replay) => {
    const result = await upstreams.upstreams.bid.submitBid({
      tenant_id: "tenant_demo",
      rfq_id: "rfq_plain",
      supplier_id: "sup_a",
      supplier_name: "A",
      unit_price: 1.5,
      lead_time_days: 3,
      idempotency_key: key,
    });
    expect(result.replay).toBe(replay);
    expect(result.bid).toMatchObject({ bid_id: "bid_x", unit_price: 1.5, lead_time_days: 3 });
  });

  it("enforces the 800 ms pricing deadline and records it as a timeout", async () => {
    const started = Date.now();
    const err = await upstreams.upstreams.pricing.getPriceEstimate("SLOW", 10).catch((e: unknown) => e);
    const elapsed = Date.now() - started;
    expect(err).toMatchObject({ service: "pricing-service", code: grpc.status.DEADLINE_EXCEEDED });
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(elapsed).toBeLessThan(1_400);
    expect(upstreams.recorders.get("pricing-service")!.stats().timeouts).toBe(1);

    const ok = await upstreams.upstreams.pricing.getPriceEstimate("BOLT-M8", 40000);
    expect(ok.estimate).toMatchObject({ sku: "BOLT-M8", quantity: 40000, cache_hit: true });
    expect(ok.latencyMs).toBeGreaterThan(0);
  });

  it("probes health over the shared channel and reports readiness", async () => {
    for (const probe of upstreams.probes) expect(await probe.check()).toEqual({ ok: true });
    expect(upstreams.probes.every((p) => p.isReady())).toBe(true);
  });

  it("fails fast with UNAVAILABLE when the upstream is unreachable", async () => {
    const err = await unreachable.upstreams.rfq.listRfqs("tenant_demo").catch((e: unknown) => e);
    expect(err).toMatchObject({ service: "rfq-service", code: grpc.status.UNAVAILABLE });
    expect(unreachable.recorders.get("rfq-service")!.stats().unavailable).toBe(1);
    expect(await unreachable.probes[0]!.check()).toEqual({ ok: false, reason: "unreachable" });
    expect(unreachable.probes[0]!.isReady()).toBe(false);
  });
});
