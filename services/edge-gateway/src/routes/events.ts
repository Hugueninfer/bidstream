import type { FastifyInstance } from "fastify";
import type { OutgoingHttpHeaders } from "node:http";
import type { ActivityHub } from "../activity/hub.js";
import type { HealthReporter } from "../health/monitor.js";
import type { ActivityEvent } from "../types.js";
import { DEFAULT_TENANT } from "./rfqs.js";

export type SseOptions = {
  backlog?: number;
  healthIntervalMs?: number;
  pingIntervalMs?: number;
};

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
  // Tells nginx-style proxies not to buffer the stream.
  "x-accel-buffering": "no",
} as const;

function activityFrame(event: ActivityEvent): string {
  return `event: activity\nid: ${event.event_id}\ndata: ${JSON.stringify(event)}\n\n`;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * GET /v1/events — Server-Sent Events for the activity feed and health.
 *
 * The reply is hijacked so Fastify stops managing it; headers that hooks already
 * set on the reply (CORS) are copied onto the raw response by hand.
 */
export function eventsRoutes(
  app: FastifyInstance,
  hub: ActivityHub,
  health: HealthReporter,
  opts: SseOptions = {},
): void {
  const backlog = opts.backlog ?? 50;
  const healthIntervalMs = opts.healthIntervalMs ?? 5_000;
  const pingIntervalMs = opts.pingIntervalMs ?? 15_000;
  const open = new Set<() => void>();

  // Long-lived streams would otherwise keep app.close() waiting forever.
  app.addHook("preClose", async () => {
    for (const close of [...open]) close();
  });

  app.get<{ Querystring: { tenant_id?: string } }>(
    "/v1/events",
    {
      schema: {
        tags: ["events"],
        summary: "Activity feed and health as Server-Sent Events",
        description:
          "On connect: the last 50 events for the tenant (oldest first) as `event: activity`, then live ones. " +
          "`event: health` every 5 s with the /v1/health payload, and a `: ping` comment every 15 s. " +
          "Honors `Last-Event-ID` when the event is still buffered.",
        querystring: {
          type: "object",
          properties: { tenant_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" } },
        },
        response: {
          200: {
            description: "text/event-stream",
            content: { "text/event-stream": { schema: { type: "string" } } },
          },
        },
      },
    },
    (request, reply) => {
      const tenant = request.query.tenant_id || DEFAULT_TENANT;
      const lastEventId = request.headers["last-event-id"];

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, { ...(reply.getHeaders() as OutgoingHttpHeaders), ...SSE_HEADERS });
      res.socket?.setNoDelay(true);

      const write = (chunk: string) => {
        if (!res.writableEnded && !res.destroyed) res.write(chunk);
      };

      write("retry: 3000\n\n");
      const resumed = typeof lastEventId === "string" ? hub.since(tenant, lastEventId) : null;
      for (const event of resumed ?? hub.recent(tenant, backlog)) write(activityFrame(event));
      write(frame("health", health.snapshot()));

      const unsubscribe = hub.subscribe(tenant, (event) => write(activityFrame(event)));
      const healthTimer = setInterval(() => write(frame("health", health.snapshot())), healthIntervalMs);
      const pingTimer = setInterval(() => write(": ping\n\n"), pingIntervalMs);

      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(healthTimer);
        clearInterval(pingTimer);
        open.delete(close);
        if (!res.writableEnded) res.end();
        request.log.debug({ tenant }, "sse stream closed");
      };
      open.add(close);
      res.on("close", close);
      res.on("error", close);
      request.log.debug({ tenant, resumed: resumed !== null }, "sse stream opened");
    },
  );
}
