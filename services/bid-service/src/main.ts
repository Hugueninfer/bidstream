import { setTimeout as sleep } from 'node:timers/promises';
import { BidService } from './bids/service.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { RfqEventsConsumer } from './events/consumer.js';
import { OutboxRelay } from './events/relay.js';
import { createGrpcServer } from './grpc/server.js';
import { createKafka, createProducer } from './kafka.js';
import { createLogger, type Logger } from './logger.js';
import { startTelemetry } from './telemetry.js';

const SHUTDOWN_TIMEOUT_MS = 15_000;
const GRPC_DRAIN_TIMEOUT_MS = 5_000;

/** Postgres may still be starting when the container comes up. */
async function migrateWithRetry(run: () => Promise<string[]>, logger: Logger): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await run();
      return;
    } catch (err) {
      if (attempt >= 10) throw err;
      logger.warn({ err, attempt }, 'migrations failed; retrying');
      await sleep(Math.min(500 * 2 ** (attempt - 1), 5_000));
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.serviceName);
  const telemetry = startTelemetry({ serviceName: config.serviceName, endpoint: config.otlpEndpoint, logger });

  const pool = createPool(config.databaseUrl, logger);
  const kafka = createKafka(config.kafkaBrokers, logger);
  const producer = createProducer(kafka);
  const relay = new OutboxRelay(pool, producer, logger.child({ component: 'outbox-relay' }));
  const consumer = new RfqEventsConsumer(kafka, producer, pool, logger.child({ component: 'rfq-consumer' }), (err) => {
    logger.fatal({ err }, 'kafka consumer crashed');
    void shutdown('consumer-crash', 1);
  });
  const grpcServer = createGrpcServer({ bidService: new BidService(pool), protoDir: config.protoDir, logger });

  let shuttingDown = false;
  async function shutdown(reason: string, exitCode = 0): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, 'shutting down');
    const force = setTimeout(() => {
      logger.error('shutdown timed out; exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    // Reverse start order; each step is best effort so the rest still runs.
    const steps: [string, () => Promise<unknown>][] = [
      [
        'grpc',
        async () => {
          grpcServer.setServing(false);
          await grpcServer.shutdown(GRPC_DRAIN_TIMEOUT_MS);
        },
      ],
      ['consumer', () => consumer.stop()],
      ['relay', () => relay.stop()],
      ['producer', () => producer.disconnect()],
      ['postgres', () => pool.end()],
      ['telemetry', () => telemetry.shutdown()],
    ];
    for (const [name, step] of steps) {
      await step().catch((err: unknown) => logger.warn({ err, step: name }, 'shutdown step failed'));
    }
    logger.info('shutdown complete');
    process.exit(exitCode);
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  try {
    await migrateWithRetry(() => migrate(pool, config.migrationsDir, logger), logger);
    await producer.connect();
    relay.start();
    await consumer.start();
    const port = await grpcServer.listen(config.grpcPort);
    grpcServer.setServing(true);
    logger.info({ port }, 'bid-service ready');
  } catch (err) {
    logger.fatal({ err }, 'startup failed');
    await shutdown('startup-failure', 1);
  }
}

main().catch((err: unknown) => {
  // Only reachable if config or logger creation failed; nothing to clean up yet.
  console.error(JSON.stringify({ level: 'fatal', msg: 'bid-service failed to start', err: String(err) }));
  process.exit(1);
});
