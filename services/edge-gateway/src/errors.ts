import { status as GrpcStatus } from "@grpc/grpc-js";
import type { ErrorBody } from "./types.js";
import type { UpstreamError } from "./clients/errors.js";

/** An error that becomes `{"error": {code, message}}` with the given HTTP status. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toBody(): { error: ErrorBody } {
    return { error: { code: this.code, message: this.message } };
  }
}

export const notFound = (message: string) => new ApiError(404, "not_found", message);
export const rfqClosed = (message: string) => new ApiError(409, "rfq_closed", message);
export const validationError = (message: string) => new ApiError(400, "validation_error", message);

/**
 * Translates an upstream gRPC failure into the public error contract.
 * Anything that is not a well-defined business outcome is reported as the
 * upstream being unavailable (pricing has its own code so the UI can degrade).
 */
export function fromUpstream(err: UpstreamError): ApiError {
  const details = err.details || "no details";
  switch (err.code) {
    case GrpcStatus.INVALID_ARGUMENT:
      return validationError(details);
    case GrpcStatus.NOT_FOUND:
      return notFound(details);
    case GrpcStatus.FAILED_PRECONDITION:
      return rfqClosed(details);
    default: {
      const pricing = err.service === "pricing-service";
      const reason =
        err.code === GrpcStatus.DEADLINE_EXCEEDED
          ? "timed out"
          : err.code === GrpcStatus.UNAVAILABLE
            ? "is unavailable"
            : `failed (${GrpcStatus[err.code] ?? err.code})`;
      return new ApiError(
        503,
        pricing ? "pricing_unavailable" : "upstream_unavailable",
        `${err.service} ${reason}`,
      );
    }
  }
}
