import type { FastifyInstance } from "fastify";
import type { PricingClient } from "../clients/types.js";
import { SKUS } from "../catalog.js";
import { toPriceEstimate } from "../mapping.js";
import { errors, ref } from "./schemas.js";

export function catalogRoutes(app: FastifyInstance, pricing: PricingClient): void {
  app.get(
    "/v1/skus",
    {
      schema: {
        tags: ["catalog"],
        summary: "SKU catalog",
        response: {
          200: {
            type: "object",
            required: ["skus"],
            properties: {
              skus: {
                type: "array",
                items: {
                  type: "object",
                  required: ["sku", "unit"],
                  properties: { sku: { type: "string" }, unit: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
    async () => ({ skus: SKUS }),
  );

  app.get<{ Querystring: { sku: string; qty: number } }>(
    "/v1/estimate",
    {
      schema: {
        tags: ["catalog"],
        summary: "Price estimate for a SKU at a quantity",
        querystring: {
          type: "object",
          required: ["sku", "qty"],
          properties: {
            sku: { type: "string", minLength: 1, maxLength: 64 },
            qty: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
          },
        },
        response: { 200: ref("PriceEstimate"), ...errors(400, 404, 503) },
      },
    },
    async (request) => {
      const { sku, qty } = request.query;
      const { estimate, latencyMs } = await pricing.getPriceEstimate(sku, qty);
      return toPriceEstimate(estimate, latencyMs);
    },
  );
}
