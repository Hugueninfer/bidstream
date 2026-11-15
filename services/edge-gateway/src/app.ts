import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance, type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { isUpstreamError } from "./clients/errors.js";
import type { Upstreams } from "./clients/types.js";
import { ApiError, fromUpstream } from "./errors.js";
import type { ActivityHub } from "./activity/hub.js";
import type { HealthReporter } from "./health/monitor.js";
import { catalogRoutes } from "./routes/catalog.js";
import { eventsRoutes, type SseOptions } from "./routes/events.js";
import { healthRoutes } from "./routes/health.js";
import { rfqRoutes } from "./routes/rfqs.js";
import { SHARED_SCHEMAS } from "./routes/schemas.js";

export type AppDeps = {
  upstreams: Upstreams;
  health: HealthReporter;
  activity: ActivityHub;
  corsOrigins: string[];
  /** Omit to run silently (tests). */
  logger?: FastifyBaseLogger;
  sse?: SseOptions;
};

/**
 * Bodies are validated strictly (no type coercion, so `"5"` is not a number);
 * querystring, params and headers are strings on the wire and get coerced.
 */
function buildValidators() {
  const make = (coerceTypes: boolean | "array") => {
    const ajv = new Ajv({ coerceTypes, useDefaults: true, removeAdditional: false, allErrors: false, strict: false });
    addFormats.default(ajv);
    return ajv;
  };
  return { body: make(false), other: make("array") };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const options: FastifyServerOptions = {
    logController: new LogController({
      disableRequestLogging: (req) => req.url === "/healthz" || req.url === "/readyz",
    }),
    requestIdHeader: "x-request-id",
  };
  const app: FastifyInstance = deps.logger
    ? Fastify({ ...options, loggerInstance: deps.logger })
    : Fastify({ ...options, logger: false });

  const validators = buildValidators();
  app.setValidatorCompiler(({ schema, httpPart }) =>
    (httpPart === "body" ? validators.body : validators.other).compile(schema),
  );
  for (const schema of SHARED_SCHEMAS) app.addSchema(schema);

  await app.register(cors, {
    origin: deps.corsOrigins,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Tenant-Id", "Idempotency-Key", "Last-Event-ID"],
    maxAge: 600,
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "BidStream public API",
        version: "1.0.0",
        description:
          'Edge gateway REST + SSE API. Errors always look like `{"error": {"code": "...", "message": "..."}}`.',
      },
      tags: [
        { name: "rfqs" },
        { name: "bids" },
        { name: "catalog" },
        { name: "health" },
        { name: "events" },
      ],
    },
    refResolver: { buildLocalReference: (json: { $id?: unknown }, _base: unknown, _fragment: unknown, i: number) =>
        String(json.$id ?? `def-${i}`), },
  });

  app.setErrorHandler((err: FastifyError | ApiError | Error, request, reply) => {
    let api: ApiError;
    if (err instanceof ApiError) api = err;
    else if (isUpstreamError(err)) api = fromUpstream(err);
    else if ("validation" in err && err.validation) api = new ApiError(400, "validation_error", err.message);
    else if ("statusCode" in err && typeof err.statusCode === "number" && err.statusCode < 500) {
      // Fastify's own client errors: malformed JSON, wrong content type, body too large...
      api = new ApiError(err.statusCode, "validation_error", err.message);
    } else {
      request.log.error({ err }, "unhandled error");
      api = new ApiError(500, "internal_error", "internal error");
    }
    if (api.statusCode >= 500) request.log.warn({ code: api.code, err }, api.message);
    return reply.code(api.statusCode).send(api.toBody());
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(new ApiError(404, "not_found", `route ${request.method} ${request.url} not found`).toBody()),
  );

  app.get("/openapi.json", { schema: { hide: true } }, async () => app.swagger());

  rfqRoutes(app, deps.upstreams);
  catalogRoutes(app, deps.upstreams.pricing);
  healthRoutes(app, deps.health);
  eventsRoutes(app, deps.activity, deps.health, deps.sse);

  return app;
}
