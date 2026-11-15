// Loaded with `node --import ./dist/tracing.js` so instrumentation is in place
// before fastify and @grpc/grpc-js are imported. Tracing is opt-in: nothing
// happens unless OTEL_EXPORTER_OTLP_ENDPOINT is set, and failures here are
// logged and swallowed so they can never take requests down with them.
import { register } from "node:module";

type Shutdown = () => Promise<void>;
let shutdown: Shutdown = async () => {};

export function shutdownTracing(): Promise<void> {
  return shutdown().catch(() => undefined);
}

async function start(): Promise<void> {
  // Traces only; jaeger does not accept OTLP metrics or logs.
  process.env.OTEL_METRICS_EXPORTER ??= "none";
  process.env.OTEL_LOGS_EXPORTER ??= "none";
  process.env.OTEL_SERVICE_NAME ??= "edge-gateway";

  // ESM hook so `import` of instrumented packages is patched too.
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);

  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  const { HttpInstrumentation } = await import("@opentelemetry/instrumentation-http");
  const { GrpcInstrumentation } = await import("@opentelemetry/instrumentation-grpc");

  const quietPaths = new Set(["/healthz", "/readyz", "/v1/events"]);
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        // Probes are noise, and an SSE span would stay open for the whole connection.
        ignoreIncomingRequestHook: (req) => quietPaths.has((req.url ?? "").split("?")[0] ?? ""),
      }),
      new GrpcInstrumentation({ ignoreGrpcMethods: ["Check"] }),
    ],
  });
  sdk.start();
  shutdown = () => sdk.shutdown();
}

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  try {
    await start();
  } catch (err) {
    console.error("tracing disabled: failed to start OpenTelemetry", err);
  }
}
