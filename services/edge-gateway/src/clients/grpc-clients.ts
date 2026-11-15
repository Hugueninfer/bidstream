import * as grpc from "@grpc/grpc-js";
import type { ServiceName } from "../types.js";
import { LatencyRecorder } from "../health/latency.js";
import type { HealthProbe } from "../health/monitor.js";
import type { ProbeResult } from "../health/status.js";
import { loadServices, type ServiceConstructors } from "./proto.js";
import { UnaryCaller } from "./unary.js";
import type {
  BidClient,
  CreateRfqInput,
  PricingClient,
  ProtoBid,
  ProtoPriceEstimate,
  ProtoRfq,
  RfqClient,
  SubmitBidInput,
  Upstreams,
} from "./types.js";

export const PRICING_DEADLINE_MS = 800;
export const DEFAULT_DEADLINE_MS = 2_000;
const PROBE_DEADLINE_MS = 1_000;

// Reconnect quickly: upstreams often start after the gateway in docker compose,
// and grpc-js' default backoff grows to two minutes.
const CHANNEL_OPTIONS: grpc.ChannelOptions = {
  "grpc.initial_reconnect_backoff_ms": 500,
  "grpc.max_reconnect_backoff_ms": 5_000,
  "grpc.keepalive_time_ms": 30_000,
};

export const REPLAY_HEADER = "x-idempotent-replay";

export class GrpcRfqClient implements RfqClient {
  constructor(private readonly caller: UnaryCaller) {}

  async createRfq(input: CreateRfqInput): Promise<ProtoRfq> {
    return (await this.caller.call<ProtoRfq>("CreateRfq", input)).response;
  }

  async getRfq(tenantId: string, rfqId: string): Promise<ProtoRfq> {
    return (await this.caller.call<ProtoRfq>("GetRfq", { tenant_id: tenantId, rfq_id: rfqId })).response;
  }

  async listRfqs(tenantId: string, status = ""): Promise<ProtoRfq[]> {
    const { response } = await this.caller.call<{ rfqs: ProtoRfq[] }>("ListRfqs", { tenant_id: tenantId, status });
    return response.rfqs ?? [];
  }

  async awardRfq(tenantId: string, rfqId: string, bidId: string): Promise<ProtoRfq> {
    const req = { tenant_id: tenantId, rfq_id: rfqId, bid_id: bidId };
    return (await this.caller.call<ProtoRfq>("AwardRfq", req)).response;
  }
}

export class GrpcBidClient implements BidClient {
  constructor(private readonly caller: UnaryCaller) {}

  async submitBid(input: SubmitBidInput): Promise<{ bid: ProtoBid; replay: boolean }> {
    const { response, metadata } = await this.caller.call<ProtoBid>("SubmitBid", input);
    const replay = metadata.get(REPLAY_HEADER).some((v) => String(v).toLowerCase() === "true");
    return { bid: response, replay };
  }

  async listBids(tenantId: string, rfqId: string): Promise<ProtoBid[]> {
    const { response } = await this.caller.call<{ bids: ProtoBid[] }>("ListBids", {
      tenant_id: tenantId,
      rfq_id: rfqId,
    });
    return response.bids ?? [];
  }
}

export class GrpcPricingClient implements PricingClient {
  constructor(private readonly caller: UnaryCaller) {}

  async getPriceEstimate(sku: string, quantity: number) {
    const { response, latencyMs } = await this.caller.call<ProtoPriceEstimate>("GetPriceEstimate", { sku, quantity });
    return { estimate: response, latencyMs };
  }
}

type HealthCheckMethod = (
  request: { service: string },
  options: grpc.CallOptions,
  callback: (err: grpc.ServiceError | null, response?: { status?: string }) => void,
) => grpc.ClientUnaryCall;

/** Health probe that shares the business client's channel, so readiness reflects real traffic. */
export class GrpcHealthProbe implements HealthProbe {
  private readonly health: grpc.Client;

  constructor(
    readonly name: ServiceName,
    private readonly channelOwner: grpc.Client,
    Health: grpc.ServiceClientConstructor,
  ) {
    this.health = new Health("unused", grpc.credentials.createInsecure(), {
      channelOverride: channelOwner.getChannel(),
    });
  }

  check(): Promise<ProbeResult> {
    return new Promise((resolve) => {
      const check = (this.health as unknown as { Check: HealthCheckMethod }).Check;
      check.call(
        this.health,
        { service: "" },
        { deadline: Date.now() + PROBE_DEADLINE_MS },
        (err, res) => {
          if (err) {
            const reason =
              err.code === grpc.status.DEADLINE_EXCEEDED
                ? "health check timed out"
                : err.code === grpc.status.UNAVAILABLE
                  ? "unreachable"
                  : `health check failed: ${grpc.status[err.code] ?? err.code}`;
            resolve({ ok: false, reason });
          } else if (res?.status !== "SERVING") {
            resolve({ ok: false, reason: `not serving (${res?.status ?? "UNKNOWN"})` });
          } else {
            resolve({ ok: true });
          }
        },
      );
    });
  }

  isReady(): boolean {
    // `true` asks an idle channel to start connecting.
    return this.channelOwner.getChannel().getConnectivityState(true) === grpc.connectivityState.READY;
  }
}

export type GrpcUpstreams = {
  upstreams: Upstreams;
  probes: HealthProbe[];
  recorders: Map<ServiceName, LatencyRecorder>;
  close(): void;
};

export function createGrpcUpstreams(
  addrs: { rfq: string; bid: string; pricing: string },
  protoDirOrServices: string | ServiceConstructors,
): GrpcUpstreams {
  const services = typeof protoDirOrServices === "string" ? loadServices(protoDirOrServices) : protoDirOrServices;
  const creds = grpc.credentials.createInsecure();
  const recorders = new Map<ServiceName, LatencyRecorder>();

  const make = (name: ServiceName, Ctor: grpc.ServiceClientConstructor, addr: string, deadlineMs: number) => {
    const client = new Ctor(addr, creds, CHANNEL_OPTIONS);
    const recorder = new LatencyRecorder();
    recorders.set(name, recorder);
    return {
      client,
      caller: new UnaryCaller(name, client, deadlineMs, recorder),
      probe: new GrpcHealthProbe(name, client, services.Health),
    };
  };

  const rfq = make("rfq-service", services.RfqService, addrs.rfq, DEFAULT_DEADLINE_MS);
  const bid = make("bid-service", services.BidService, addrs.bid, DEFAULT_DEADLINE_MS);
  const pricing = make("pricing-service", services.PricingService, addrs.pricing, PRICING_DEADLINE_MS);

  return {
    upstreams: {
      rfq: new GrpcRfqClient(rfq.caller),
      bid: new GrpcBidClient(bid.caller),
      pricing: new GrpcPricingClient(pricing.caller),
    },
    probes: [rfq.probe, bid.probe, pricing.probe],
    recorders,
    close() {
      for (const { client } of [rfq, bid, pricing]) client.close();
    },
  };
}
