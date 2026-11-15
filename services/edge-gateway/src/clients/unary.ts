import * as grpc from "@grpc/grpc-js";
import type { ServiceName } from "../types.js";
import type { CallOutcome, LatencyRecorder } from "../health/latency.js";
import { UpstreamError } from "./errors.js";

export type UnaryResult<Res> = {
  response: Res;
  /** Initial metadata and trailers merged (trailers win). */
  metadata: grpc.Metadata;
  latencyMs: number;
};

type UnaryMethod = (
  request: unknown,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (err: grpc.ServiceError | null, response?: unknown) => void,
) => grpc.ClientUnaryCall;

export function outcomeOf(code: grpc.status): CallOutcome {
  switch (code) {
    case grpc.status.OK:
    // Business answers (bad input, missing entity, closed RFQ) mean the service is fine.
    case grpc.status.INVALID_ARGUMENT:
    case grpc.status.NOT_FOUND:
    case grpc.status.FAILED_PRECONDITION:
    case grpc.status.ALREADY_EXISTS:
      return "ok";
    case grpc.status.DEADLINE_EXCEEDED:
      return "timeout";
    case grpc.status.UNAVAILABLE:
      return "unavailable";
    default:
      return "error";
  }
}

/**
 * Wraps a grpc-js client: applies the deadline, records latency for health,
 * and turns failures into UpstreamError.
 */
export class UnaryCaller {
  constructor(
    readonly service: ServiceName,
    private readonly client: grpc.Client,
    private readonly deadlineMs: number,
    private readonly recorder: LatencyRecorder,
  ) {}

  call<Res>(method: string, request: object): Promise<UnaryResult<Res>> {
    const fn = (this.client as unknown as Record<string, UnaryMethod | undefined>)[method];
    if (typeof fn !== "function") {
      return Promise.reject(new Error(`${this.service} has no method ${method}`));
    }
    const started = performance.now();
    const metadata = new grpc.Metadata();
    const received = new grpc.Metadata();

    return new Promise((resolve, reject) => {
      let outcome: { err: grpc.ServiceError | null; response?: unknown } | undefined;
      const call = fn.call(
        this.client,
        request,
        metadata,
        { deadline: Date.now() + this.deadlineMs },
        (err, response) => {
          outcome = { err, response };
        },
      );
      call.on("metadata", (md: grpc.Metadata) => received.merge(md));
      // grpc-js emits "status" right after invoking the callback, so trailers
      // and the result are both available here.
      call.on("status", (status: grpc.StatusObject) => {
        received.merge(status.metadata);
        const latencyMs = performance.now() - started;
        const code = outcome?.err?.code ?? status.code;
        this.recorder.record(latencyMs, outcomeOf(code));
        if (outcome?.err || code !== grpc.status.OK) {
          const details = outcome?.err?.details ?? status.details;
          reject(new UpstreamError(this.service, code, details));
          return;
        }
        resolve({ response: outcome?.response as Res, metadata: received, latencyMs });
      });
    });
  }
}
