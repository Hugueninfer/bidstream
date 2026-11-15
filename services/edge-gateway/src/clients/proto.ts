import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

// Options mandated by docs/contracts.md for TypeScript services.
export const LOADER_OPTIONS: protoLoader.Options = {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: true,
  oneofs: true,
};

export type ServiceConstructors = {
  RfqService: grpc.ServiceClientConstructor;
  BidService: grpc.ServiceClientConstructor;
  PricingService: grpc.ServiceClientConstructor;
  Health: grpc.ServiceClientConstructor;
};

/**
 * The standard grpc.health.v1 service (not part of the repo's protos), defined
 * inline so the gateway does not need a vendored .proto file.
 */
const HEALTH_JSON = {
  nested: {
    grpc: {
      nested: {
        health: {
          nested: {
            v1: {
              nested: {
                HealthCheckRequest: { fields: { service: { type: "string", id: 1 } } },
                HealthCheckResponse: {
                  fields: { status: { type: "ServingStatus", id: 1 } },
                  nested: {
                    ServingStatus: { values: { UNKNOWN: 0, SERVING: 1, NOT_SERVING: 2, SERVICE_UNKNOWN: 3 } },
                  },
                },
                Health: {
                  methods: {
                    Check: { requestType: "HealthCheckRequest", responseType: "HealthCheckResponse" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

function lookup(root: grpc.GrpcObject, dotted: string): grpc.ServiceClientConstructor {
  let node: unknown = root;
  for (const part of dotted.split(".")) node = (node as Record<string, unknown> | undefined)?.[part];
  if (typeof node !== "function") throw new Error(`gRPC service ${dotted} not found in loaded protos`);
  return node as grpc.ServiceClientConstructor;
}

export function healthPackageDefinition(): protoLoader.PackageDefinition {
  return protoLoader.fromJSON(HEALTH_JSON as Parameters<typeof protoLoader.fromJSON>[0], LOADER_OPTIONS);
}

export function loadPackageDefinition(protoDir: string): protoLoader.PackageDefinition {
  const files = ["rfq/v1/rfq.proto", "bid/v1/bid.proto", "pricing/v1/pricing.proto"].map((f) =>
    path.join("bidstream", f),
  );
  return protoLoader.loadSync(files, { ...LOADER_OPTIONS, includeDirs: [protoDir] });
}

export function loadServices(protoDir: string): ServiceConstructors {
  const app = grpc.loadPackageDefinition(loadPackageDefinition(protoDir));
  const health = grpc.loadPackageDefinition(healthPackageDefinition());
  return {
    RfqService: lookup(app, "bidstream.rfq.v1.RfqService"),
    BidService: lookup(app, "bidstream.bid.v1.BidService"),
    PricingService: lookup(app, "bidstream.pricing.v1.PricingService"),
    Health: lookup(health, "grpc.health.v1.Health"),
  };
}
