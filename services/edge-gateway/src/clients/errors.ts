import { status as GrpcStatus } from "@grpc/grpc-js";
import type { ServiceName } from "../types.js";

/** A failed call to an upstream service, carrying the gRPC status code. */
export class UpstreamError extends Error {
  constructor(
    readonly service: ServiceName,
    readonly code: GrpcStatus,
    readonly details: string,
  ) {
    super(`${service}: ${GrpcStatus[code] ?? code}: ${details}`);
    this.name = "UpstreamError";
  }
}

export function isUpstreamError(err: unknown): err is UpstreamError {
  return err instanceof UpstreamError;
}
