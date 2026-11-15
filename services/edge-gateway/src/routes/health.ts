import type { FastifyInstance } from "fastify";
import type { HealthReporter } from "../health/monitor.js";
import { ref } from "./schemas.js";

export function healthRoutes(app: FastifyInstance, health: HealthReporter): void {
  app.get(
    "/v1/health",
    {
      schema: {
        tags: ["health"],
        summary: "Upstream service health as seen by the gateway",
        response: { 200: ref("Health") },
      },
    },
    async () => health.snapshot(),
  );

  app.get(
    "/healthz",
    {
      schema: {
        tags: ["health"],
        summary: "Liveness",
        response: { 200: { type: "object", properties: { status: { type: "string", enum: ["ok"] } } } },
      },
    },
    async () => ({ status: "ok" }),
  );

  const readiness = {
    type: "object",
    required: ["status", "channels"],
    properties: {
      status: { type: "string", enum: ["ready", "not_ready"] },
      channels: { type: "object", additionalProperties: { type: "boolean" } },
    },
  };

  app.get(
    "/readyz",
    {
      schema: {
        tags: ["health"],
        summary: "Readiness: 200 only when every upstream gRPC channel is READY",
        response: { 200: readiness, 503: readiness },
      },
    },
    async (_request, reply) => {
      const { ready, channels } = health.readiness();
      return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready", channels });
    },
  );
}
