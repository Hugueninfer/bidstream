import { setTimeout as sleep } from 'node:timers/promises';
import type { Producer } from 'kafkajs';
import { withTransaction, type Pool } from '../db/pool.js';
import type { Logger } from '../logger.js';

interface OutboxRow {
  id: string; // BIGSERIAL arrives as a string
  topic: string;
  key: string;
  payload: unknown;
  headers: Record<string, string>;
}

export interface RelayOptions {
  pollIntervalMs?: number;
  batchSize?: number;
  /** Pause after a failed publish so a Kafka outage does not become a hot loop. */
  errorBackoffMs?: number;
}

/**
 * Drains the outbox into Kafka (at-least-once).
 *
 * Each batch is selected FOR UPDATE SKIP LOCKED inside a transaction that stays
 * open until Kafka acknowledged every message, so several replicas can relay
 * in parallel without publishing the same row twice in the happy path. If the
 * process dies between the ack and the COMMIT the batch is re-sent; consumers
 * dedupe on event_id. Per-key order is strict with one relay; with several
 * replicas two batches may interleave, which consumers tolerate (each event
 * is applied independently and idempotently).
 */
export class OutboxRelay {
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly errorBackoffMs: number;
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly producer: Producer,
    private readonly logger: Logger,
    options: RelayOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.batchSize = options.batchSize ?? 100;
    this.errorBackoffMs = options.errorBackoffMs ?? 1_000;
  }

  start(): void {
    this.loop ??= this.run();
  }

  /** Stops polling and waits for the batch in flight (if any) to finish. */
  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  /** Publishes one batch; returns how many rows were relayed. */
  async relayBatch(): Promise<number> {
    return withTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<OutboxRow>(
        `SELECT id, topic, key, payload, headers FROM outbox
         WHERE published_at IS NULL
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      if (rows.length === 0) return 0;

      // Group by topic, keeping outbox order so one RFQ's events stay ordered.
      const byTopic = new Map<string, OutboxRow[]>();
      for (const row of rows) byTopic.set(row.topic, [...(byTopic.get(row.topic) ?? []), row]);

      await this.producer.sendBatch({
        acks: -1,
        topicMessages: [...byTopic].map(([topic, topicRows]) => ({
          topic,
          messages: topicRows.map((row) => ({
            key: row.key,
            value: JSON.stringify(row.payload),
            headers: row.headers,
          })),
        })),
      });

      await tx.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [rows.map((r) => r.id)]);
      this.logger.debug({ count: rows.length }, 'outbox batch published');
      return rows.length;
    });
  }

  private async run(): Promise<void> {
    const { signal } = this.abort;
    while (!signal.aborted) {
      let delay = this.pollIntervalMs;
      try {
        // A full batch probably means more is waiting: go again immediately.
        if ((await this.relayBatch()) === this.batchSize) delay = 0;
      } catch (err) {
        this.logger.error({ err }, 'outbox relay failed; will retry');
        delay = this.errorBackoffMs;
      }
      if (delay > 0) await sleep(delay, undefined, { signal }).catch(() => {});
    }
  }
}
