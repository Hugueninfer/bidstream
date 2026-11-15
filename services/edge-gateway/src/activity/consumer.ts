import { randomUUID } from "node:crypto";
import kafkajs, { type Consumer, type EachMessagePayload, type IHeaders, type LogEntry } from "kafkajs";
import SnappyCodec from "kafkajs-snappy";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, propagation, trace } from "@opentelemetry/api";
import type { Logger } from "pino";
import type { ActivityHub } from "./hub.js";
import { MalformedEventError, parseEnvelope, toActivityEvent } from "./summary.js";

// kafkajs is CommonJS and Node cannot detect all of its named exports.
const { CompressionCodecs, CompressionTypes, Kafka, logLevel } = kafkajs;

export const ACTIVITY_TOPICS = ["rfq.events", "bid.events"];
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

// kafkajs only ships gzip. Snappy is rpk's default and common elsewhere, and a
// batch we cannot decode would stall the whole consumer.
CompressionCodecs[CompressionTypes.Snappy] = SnappyCodec;

const tracer = trace.getTracer("edge-gateway.activity");

function headersToCarrier(headers: IHeaders | undefined): Record<string, string> {
  const carrier: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) carrier[name] = first.toString();
  }
  return carrier;
}

function kafkaLogCreator(logger: Logger) {
  return () =>
    ({ namespace, level, log }: LogEntry) => {
      const { message, timestamp: _ts, ...extra } = log;
      const fields = { component: "kafkajs", namespace, ...extra };
      if (level === logLevel.ERROR) logger.error(fields, message);
      else if (level === logLevel.WARN) logger.warn(fields, message);
      else if (level === logLevel.INFO) logger.info(fields, message);
      else logger.debug(fields, message);
    };
}

/**
 * Feeds the activity hub from rfq.events and bid.events.
 *
 * Every gateway instance uses its own throwaway consumer group and reads from
 * the beginning without committing offsets, so a fresh process rebuilds its
 * in-memory buffer and every instance sees every event.
 */
export class ActivityConsumer {
  private consumer: Consumer | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private readonly malformedSeen = new Set<string>();
  private readonly kafka: InstanceType<typeof Kafka>;
  malformedCount = 0;

  constructor(
    brokers: string[],
    private readonly hub: ActivityHub,
    private readonly logger: Logger,
    private readonly topics: string[] = ACTIVITY_TOPICS,
  ) {
    this.kafka = new Kafka({
      clientId: "edge-gateway",
      brokers,
      logLevel: logLevel.WARN,
      logCreator: kafkaLogCreator(logger),
      // The 1 s default is too tight for a broker container that is still warming up.
      connectionTimeout: 3_000,
      retry: { initialRetryTime: 300, retries: 8 },
    });
  }

  /** Starts consuming in the background; failures are retried until stop(). */
  start(): void {
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const consumer = this.consumer;
    this.consumer = null;
    await consumer?.disconnect().catch((err: unknown) => this.logger.warn({ err }, "kafka disconnect failed"));
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const groupId = `edge-gateway-${randomUUID()}`;
    const consumer = this.kafka.consumer({ groupId, allowAutoTopicCreation: false });
    this.consumer = consumer;
    consumer.on(consumer.events.CRASH, ({ payload }) => {
      if (!payload.restart) this.scheduleReconnect(consumer, payload.error);
    });
    try {
      await consumer.connect();
      await consumer.subscribe({ topics: this.topics, fromBeginning: true });
      await consumer.run({ autoCommit: false, eachMessage: (p) => this.handle(p) });
      this.logger.info({ groupId, topics: this.topics }, "activity consumer started");
    } catch (err) {
      this.scheduleReconnect(consumer, err);
    }
  }

  private scheduleReconnect(consumer: Consumer, err: unknown): void {
    if (this.stopped || this.consumer !== consumer) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.failures++);
    this.logger.warn({ err }, `activity consumer failed, reconnecting in ${delay} ms`);
    this.consumer = null;
    void consumer.disconnect().catch(() => undefined);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
    this.reconnectTimer.unref();
  }

  /** Exposed for tests: processes one Kafka message. Never throws. */
  async handle({ topic, message }: Pick<EachMessagePayload, "topic" | "message">): Promise<void> {
    this.failures = 0;
    // Continue the producer's trace when it sent a traceparent header.
    const parent = propagation.extract(ROOT_CONTEXT, headersToCarrier(message.headers));
    const span = tracer.startSpan(
      `${topic} process`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          "messaging.system": "kafka",
          "messaging.destination.name": topic,
          "messaging.operation.type": "process",
        },
      },
      parent,
    );
    try {
      const envelope = parseEnvelope(message.value);
      span.setAttribute("messaging.message.id", envelope.event_id);
      const event = toActivityEvent(topic, envelope, message.key?.toString());
      if (event) this.hub.publish(envelope.tenant_id, event);
    } catch (err) {
      this.malformedCount++;
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
      if (!(err instanceof MalformedEventError)) {
        this.logger.error({ err, topic, offset: message.offset }, "failed to process activity event");
      } else if (!this.malformedSeen.has(topic)) {
        // Log the first malformed message per topic; afterwards only count them.
        this.malformedSeen.add(topic);
        this.logger.warn({ topic, offset: message.offset, reason: err.message }, "ignoring malformed event");
      }
    } finally {
      span.end();
    }
  }
}
