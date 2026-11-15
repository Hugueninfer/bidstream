import type { FastifyInstance, FastifyRequest } from "fastify";
import { status as GrpcStatus } from "@grpc/grpc-js";
import { isUpstreamError } from "../clients/errors.js";
import type { Upstreams } from "../clients/types.js";
import { ApiError, rfqClosed } from "../errors.js";
import { withEstimate, withEstimates } from "../estimates.js";
import { supplierIdFor, toRestBid } from "../mapping.js";
import { RFQ_STATUSES, type RfqStatus } from "../types.js";
import { errors, ref, rfqIdParams, tenantHeaders } from "./schemas.js";

export const DEFAULT_TENANT = "tenant_demo";

export function tenantOf(request: FastifyRequest): string {
  const header = request.headers["x-tenant-id"];
  return (typeof header === "string" && header) || DEFAULT_TENANT;
}

const isRfqStatus = (s: string): s is RfqStatus => (RFQ_STATUSES as readonly string[]).includes(s);

const newestFirst = <T>(items: T[], at: (item: T) => string) =>
  [...items].sort((a, b) => (Date.parse(at(b)) || 0) - (Date.parse(at(a)) || 0));

type RfqParams = { rfqId: string };

export function rfqRoutes(app: FastifyInstance, upstreams: Upstreams): void {
  const { rfq, bid, pricing } = upstreams;

  app.get<{ Querystring: { status?: RfqStatus } }>(
    "/v1/rfqs",
    {
      schema: {
        tags: ["rfqs"],
        summary: "List RFQs (newest first) with price estimates",
        headers: tenantHeaders,
        querystring: {
          type: "object",
          properties: { status: { type: "string", enum: [...RFQ_STATUSES] } },
        },
        response: {
          200: {
            type: "object",
            required: ["rfqs", "counts"],
            properties: {
              rfqs: { type: "array", items: ref("Rfq") },
              counts: {
                type: "object",
                required: ["all", "open", "awarded", "expired"],
                properties: {
                  all: { type: "integer" },
                  open: { type: "integer" },
                  awarded: { type: "integer" },
                  expired: { type: "integer" },
                },
              },
            },
          },
          ...errors(400, 503),
        },
      },
    },
    async (request) => {
      // Counts cover every RFQ, so fetch unfiltered and filter here.
      const all = await rfq.listRfqs(tenantOf(request), "");
      const counts = { all: all.length, open: 0, awarded: 0, expired: 0 };
      for (const r of all) if (isRfqStatus(r.status)) counts[r.status]++;

      const { status } = request.query;
      const selected = newestFirst(status ? all.filter((r) => r.status === status) : all, (r) => r.created_at);
      return { rfqs: await withEstimates(pricing, selected), counts };
    },
  );

  app.post<{ Body: { title: string; sku: string; quantity: number; unit: string; deadline: string } }>(
    "/v1/rfqs",
    {
      schema: {
        tags: ["rfqs"],
        summary: "Create an RFQ",
        headers: tenantHeaders,
        body: {
          type: "object",
          required: ["title", "sku", "quantity", "unit", "deadline"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            sku: { type: "string", minLength: 1, maxLength: 64, examples: ["BOLT-M8"] },
            quantity: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
            unit: { type: "string", minLength: 1, maxLength: 32 },
            deadline: { type: "string", format: "date-time", description: "RFC 3339, must be in the future" },
          },
        },
        response: { 201: ref("Rfq"), ...errors(400, 503) },
      },
    },
    async (request, reply) => {
      const created = await rfq.createRfq({ tenant_id: tenantOf(request), ...request.body });
      return reply.code(201).send(await withEstimate(pricing, created));
    },
  );

  app.get<{ Params: RfqParams }>(
    "/v1/rfqs/:rfqId",
    {
      schema: {
        tags: ["rfqs"],
        summary: "Get one RFQ with its price estimate",
        headers: tenantHeaders,
        params: rfqIdParams,
        response: { 200: ref("Rfq"), ...errors(404, 503) },
      },
    },
    async (request) => {
      const found = await rfq.getRfq(tenantOf(request), request.params.rfqId);
      return withEstimate(pricing, found);
    },
  );

  app.get<{ Params: RfqParams }>(
    "/v1/rfqs/:rfqId/bids",
    {
      schema: {
        tags: ["bids"],
        summary: "List bids on an RFQ (newest first)",
        headers: tenantHeaders,
        params: rfqIdParams,
        response: {
          200: {
            type: "object",
            required: ["bids"],
            properties: { bids: { type: "array", items: ref("Bid") } },
          },
          ...errors(404, 503),
        },
      },
    },
    async (request) => {
      const tenant = tenantOf(request);
      // bid-service returns an empty list for unknown RFQs; GetRfq gives us the 404.
      const [, bids] = await Promise.all([
        rfq.getRfq(tenant, request.params.rfqId),
        bid.listBids(tenant, request.params.rfqId),
      ]);
      return { bids: newestFirst(bids, (b) => b.submitted_at).map(toRestBid) };
    },
  );

  app.post<{
    Params: RfqParams;
    Body: { supplier_name: string; unit_price: number; lead_time_days: number; supplier_id?: string };
    Headers: { "idempotency-key"?: string };
  }>(
    "/v1/rfqs/:rfqId/bids",
    {
      schema: {
        tags: ["bids"],
        summary: "Submit a bid",
        description:
          "Send an `Idempotency-Key` header to make retries safe: a replay returns the original bid with 200.",
        headers: {
          type: "object",
          properties: {
            ...tenantHeaders.properties,
            "idempotency-key": { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        params: rfqIdParams,
        body: {
          type: "object",
          required: ["supplier_name", "unit_price", "lead_time_days"],
          properties: {
            supplier_name: { type: "string", minLength: 1, maxLength: 200 },
            unit_price: { type: "number", exclusiveMinimum: 0 },
            lead_time_days: { type: "integer", minimum: 0, maximum: 3650 },
            supplier_id: { type: "string", pattern: "^sup_[a-z0-9_]+$", maxLength: 100 },
          },
        },
        response: { 200: ref("Bid"), 201: ref("Bid"), ...errors(400, 404, 409, 503) },
      },
    },
    async (request, reply) => {
      const tenant = tenantOf(request);
      const { rfqId } = request.params;
      const current = await rfq.getRfq(tenant, rfqId);
      if (current.status !== "open") throw rfqClosed(`RFQ ${rfqId} is ${current.status} and no longer accepts bids`);

      const body = request.body;
      try {
        const { bid: created, replay } = await bid.submitBid({
          tenant_id: tenant,
          rfq_id: rfqId,
          supplier_id: body.supplier_id ?? supplierIdFor(body.supplier_name),
          supplier_name: body.supplier_name,
          unit_price: body.unit_price,
          lead_time_days: body.lead_time_days,
          idempotency_key: request.headers["idempotency-key"] ?? "",
        });
        return reply.code(replay ? 200 : 201).send(toRestBid(created));
      } catch (err) {
        // rfq-service knows the RFQ (checked above) but bid-service has not consumed rfq.created yet.
        if (isUpstreamError(err) && err.code === GrpcStatus.NOT_FOUND) {
          throw new ApiError(
            409,
            "rfq_syncing",
            `RFQ ${rfqId} was just created and is still being set up for bidding; retry in a few seconds`,
          );
        }
        throw err;
      }
    },
  );

  app.post<{ Params: RfqParams; Body: { bid_id: string } }>(
    "/v1/rfqs/:rfqId/award",
    {
      schema: {
        tags: ["rfqs"],
        summary: "Award an RFQ to a bid",
        headers: tenantHeaders,
        params: rfqIdParams,
        body: {
          type: "object",
          required: ["bid_id"],
          properties: { bid_id: { type: "string", minLength: 1, maxLength: 64 } },
        },
        response: { 200: ref("Rfq"), ...errors(400, 404, 409, 503) },
      },
    },
    async (request) => {
      // FAILED_PRECONDITION maps to 409 rfq_closed carrying rfq-service's message.
      const awarded = await rfq.awardRfq(tenantOf(request), request.params.rfqId, request.body.bid_id);
      return withEstimate(pricing, awarded);
    },
  );
}
