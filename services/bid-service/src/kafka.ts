import { Kafka, logLevel, Partitioners, type Producer } from 'kafkajs';
import { registerSnappyCodec } from './kafka-snappy.js';
import type { Logger } from './logger.js';

const PINO_LEVEL: Record<logLevel, 'error' | 'warn' | 'info' | 'debug' | undefined> = {
  [logLevel.NOTHING]: undefined,
  [logLevel.ERROR]: 'error',
  [logLevel.WARN]: 'warn',
  [logLevel.INFO]: 'info',
  [logLevel.DEBUG]: 'debug',
};

export function createKafka(brokers: string[], logger: Logger): Kafka {
  registerSnappyCodec();
  const kafkaLogger = logger.child({ component: 'kafkajs' });
  return new Kafka({
    clientId: 'bid-service',
    brokers,
    // kafkajs is chatty at INFO (joins, rebalances): keep warnings and errors.
    logLevel: logLevel.WARN,
    logCreator:
      () =>
      ({ namespace, level, log }) => {
        const pinoLevel = PINO_LEVEL[level];
        if (!pinoLevel) return;
        const { message, timestamp: _timestamp, ...extra } = log;
        kafkaLogger[pinoLevel]({ namespace, ...extra }, message);
      },
  });
}

/**
 * Idempotent producer with a single in-flight request: broker-side retries
 * can neither duplicate nor reorder messages of the same partition.
 */
export function createProducer(kafka: Kafka): Producer {
  return kafka.producer({
    idempotent: true,
    maxInFlightRequests: 1,
    createPartitioner: Partitioners.DefaultPartitioner,
    allowAutoTopicCreation: false,
  });
}
