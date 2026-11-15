import { pino } from "pino";
import { ActivityConsumer } from "./activity/consumer.js";
import { ActivityHub } from "./activity/hub.js";
import { buildApp } from "./app.js";
import { createGrpcUpstreams } from "./clients/grpc-clients.js";
import { loadConfig } from "./config.js";
import { HealthMonitor } from "./health/monitor.js";
import { shutdownTracing } from "./tracing.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.logLevel,
    base: { service: process.env.OTEL_SERVICE_NAME ?? "edge-gateway" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });

  const grpc = createGrpcUpstreams(
    { rfq: config.rfqServiceAddr, bid: config.bidServiceAddr, pricing: config.pricingServiceAddr },
    config.protoDir,
  );
  const monitor = new HealthMonitor(grpc.probes, grpc.recorders);
  const hub = new ActivityHub();
  const consumer = new ActivityConsumer(config.kafkaBrokers, hub, logger);

  const app = await buildApp({
    upstreams: grpc.upstreams,
    health: monitor,
    activity: hub,
    corsOrigins: config.corsOrigins,
    logger,
  });

  monitor.start();
  consumer.start();
  await app.listen({ host: "0.0.0.0", port: config.httpPort });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      logger.error("graceful shutdown timed out");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    try {
      await app.close(); // ends SSE streams (preClose hook) and in-flight requests
      monitor.stop();
      await consumer.stop();
      grpc.close();
      await shutdownTracing();
      logger.info("bye");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("edge-gateway failed to start", err);
  process.exit(1);
});
