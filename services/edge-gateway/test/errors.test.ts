import { status } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import { fromUpstream } from "../src/errors.js";
import { upstreamError } from "./fakes.js";

describe("fromUpstream", () => {
  it.each([
    [status.INVALID_ARGUMENT, 400, "validation_error"],
    [status.NOT_FOUND, 404, "not_found"],
    [status.FAILED_PRECONDITION, 409, "rfq_closed"],
    [status.UNAVAILABLE, 503, "upstream_unavailable"],
    [status.DEADLINE_EXCEEDED, 503, "upstream_unavailable"],
    [status.INTERNAL, 503, "upstream_unavailable"],
  ])("maps rfq-service %s to %i %s", (code, http, apiCode) => {
    const err = fromUpstream(upstreamError("rfq-service", code, "detail text"));
    expect(err.statusCode).toBe(http);
    expect(err.code).toBe(apiCode);
  });

  it("passes business messages through", () => {
    const err = fromUpstream(upstreamError("rfq-service", status.FAILED_PRECONDITION, "RFQ is already awarded"));
    expect(err.toBody()).toEqual({ error: { code: "rfq_closed", message: "RFQ is already awarded" } });
  });

  it("uses pricing_unavailable for pricing-service outages", () => {
    const timeout = fromUpstream(upstreamError("pricing-service", status.DEADLINE_EXCEEDED));
    expect(timeout.toBody()).toEqual({
      error: { code: "pricing_unavailable", message: "pricing-service timed out" },
    });
    expect(fromUpstream(upstreamError("pricing-service", status.UNAVAILABLE)).code).toBe("pricing_unavailable");
    expect(fromUpstream(upstreamError("pricing-service", status.NOT_FOUND)).code).toBe("not_found");
  });

  it("does not leak upstream internals on outages", () => {
    const err = fromUpstream(upstreamError("bid-service", status.UNAVAILABLE, "connect ECONNREFUSED 10.0.0.3:50062"));
    expect(err.message).toBe("bid-service is unavailable");
  });
});
