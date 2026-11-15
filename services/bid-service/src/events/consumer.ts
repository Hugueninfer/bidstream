import type { Consumer, IHeaders, Kafka, KafkaMessage, Producer } from 'kafkajs';
import type { Pool } from '../db/pool.js';
import type { Logger } from '../logger.js';
import { extractContext, SpanKind, withSpan } from '../telemetry.js';
import { parseEnvelope, RFQ_EVENTS_TOPIC } from './envelope.js';
import { withRetries } from './retry.js';
import { CONSUMER_NAME, handleRfqEvent } from './rfq-handler.js';

const MAX_DLQ_ERROR_LENGTH = 1_000;

function errorMessage(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.slice(0, MAX_DLQ_ERROR_LENGTH);
}

/** The original message, untouched, plus where it came from and why it failed. */
export function buildDlqMessage(
  source: { topic: string; partition: number; message: KafkaMessage },
  error: unknown,
): { key: Buffer | null; value: Buffer | null; headers: IHeaders } {
  return {
    key: source.message.key,
    value: source.message.value,
    headers: {
      ...source.message.headers,
      dlq_error: errorMessage(error),
      dlq_consumer: CONSUMER_NAME,
      dlq_topic: source.topic,
      dlq_partition: String(source.partition),
      dlq_offset: source.message.offset,
    },
  };
}

/**
 * Consumes rfq.events into rfq_view.
 *
 * Offsets: kafkajs autoCommit only commits offsets of messages whose
 * eachMessage handler resolved. Our handler resolves only after the event was
 * applied (or found to be a duplicate / unknown type) or after the original
 * message was acknowledged by the DLQ topic. If the DLQ publish itself fails
 * the handler throws, the offset is not committed and the message is
 * redelivered, so nothing is lost; redelivery is harmless thanks to
 * processed_events.
 */
export class RfqEventsConsumer {
  private readonly consumer: Consumer;
  private stopping = false;

  constructor(
    kafka: Kafka,
    private readonly producer: Producer,
    private readonly pool: Pool,
    private readonly logger: Logger,
    private readonly onFatal: (err: unknown) => void,
  ) {
    this.consumer = kafka.consumer({ groupId: CONSUMER_NAME });
    // kafkajs restarts itself after retriable crashes; anything else is fatal
    // and the process should exit so the orchestrator restarts it.
    this.consumer.on(this.consumer.events.CRASH, ({ payload }) => {
      if (!payload.restart && !this.stopping) this.onFatal(payload.error);
    });
  }

  /**
   * Connects and subscribes, then joins the group in the background: after an
   * unclean restart the join can wait out the old member's session timeout
   * (~30 s), and serving gRPC does not need to wait for that.
   */
  async start(): Promise<void> {
    await this.consumer.connect();
    // A brand-new group must see every RFQ ever created to build rfq_view.
    await this.consumer.subscribe({ topic: RFQ_EVENTS_TOPIC, fromBeginning: true });
    this.consumer
      .run({
        autoCommit: true,
        eachMessage: ({ topic, partition, message, heartbeat }) =>
          this.processMessage(topic, partition, message, heartbeat),
      })
      .catch((err: unknown) => {
        if (!this.stopping) this.onFatal(err);
      });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.consumer.disconnect();
  }

  private async processMessage(
    topic: string,
    partition: number,
    message: KafkaMessage,
    heartbeat: () => Promise<void>,
  ): Promise<void> {
    const where = { topic, partition, offset: message.offset };
    await withSpan(
      `${topic} process`,
      {
        kind: SpanKind.CONSUMER,
        parent: extractContext(message.headers ?? {}),
        attributes: {
          'messaging.system': 'kafka',
          'messaging.destination.name': topic,
          'messaging.kafka.destination.partition': partition,
          'messaging.kafka.message.offset': message.offset,
        },
      },
      async () => {
        const result = await withRetries(() => handleRfqEvent(this.pool, parseEnvelope(message.value)), {
          onRetry: async (err, attempt, delayMs) => {
            this.logger.warn({ ...where, err, attempt, delay_ms: delayMs }, 'event handling failed; retrying');
            await heartbeat().catch(() => {}); // keep group membership during backoff
          },
        });

        if (result.ok) {
          const level = result.value === 'applied' ? 'info' : 'debug';
          this.logger[level]({ ...where, outcome: result.value }, 'event handled');
          return;
        }

        this.logger.error({ ...where, err: result.error, attempts: result.attempts }, 'event sent to DLQ');
        await this.producer.send({
          topic: `${topic}.dlq`,
          acks: -1,
          messages: [buildDlqMessage({ topic, partition, message }, result.error)],
        });
      },
    );
  }
}
