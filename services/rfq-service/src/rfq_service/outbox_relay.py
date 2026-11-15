"""Publishes outbox rows to Kafka (docs/adr/0001-transactional-outbox.md)."""

import asyncio
import json
import logging
from typing import Any

from aiokafka import AIOKafkaProducer
from opentelemetry import propagate, trace
from psycopg_pool import AsyncConnectionPool

from .aio import sleep_or_stop
from .tracing import context_from_traceparent, tracer

log = logging.getLogger(__name__)

BATCH_SIZE = 100
POLL_INTERVAL_S = 0.2
ERROR_BACKOFF_S = 1.0


class OutboxRelay:
    def __init__(
        self,
        pool: AsyncConnectionPool,
        producer: AIOKafkaProducer,
        *,
        batch_size: int = BATCH_SIZE,
        poll_interval: float = POLL_INTERVAL_S,
    ) -> None:
        self._pool = pool
        self._producer = producer
        self._batch_size = batch_size
        self._poll_interval = poll_interval

    async def run(self, stop: asyncio.Event) -> None:
        log.info("outbox relay started")
        while not stop.is_set():
            try:
                published = await self.publish_batch()
            except Exception:
                log.exception("outbox relay batch failed; will retry")
                await sleep_or_stop(stop, ERROR_BACKOFF_S)
                continue
            if published < self._batch_size:  # a full batch means more may be waiting
                await sleep_or_stop(stop, self._poll_interval)

    async def publish_batch(self) -> int:
        """Publish one batch and mark it published, all inside one transaction.

        Rows stay locked (SKIP LOCKED lets other replicas take other rows) until
        Kafka acknowledged every message; any failure rolls back and the rows are
        retried, so delivery is at-least-once."""
        async with self._pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                """SELECT id, topic, key, payload, headers FROM outbox
                   WHERE published_at IS NULL
                   ORDER BY id
                   LIMIT %s
                   FOR UPDATE SKIP LOCKED""",
                (self._batch_size,),
            )
            rows = await cur.fetchall()
            if not rows:
                return 0
            # send() only enqueues; the returned futures resolve on broker ack.
            acks = [
                await self._send(topic, key, payload, headers)
                for _, topic, key, payload, headers in rows
            ]
            await asyncio.gather(*acks)
            await conn.execute(
                "UPDATE outbox SET published_at = now() WHERE id = ANY(%s)",
                ([row[0] for row in rows],),
            )
        log.info("outbox published", extra={"count": len(rows)})
        return len(rows)

    async def _send(
        self, topic: str, key: str, payload: dict[str, Any], headers: dict[str, str]
    ) -> "asyncio.Future[Any]":
        # Continue the trace of the request that wrote the row, via a producer span.
        with tracer.start_as_current_span(
            f"{topic} publish",
            context=context_from_traceparent(headers.get("traceparent")),
            kind=trace.SpanKind.PRODUCER,
            attributes={"messaging.system": "kafka", "messaging.destination.name": topic},
        ):
            carrier = dict(headers)
            propagate.inject(carrier)  # no-op without an active span: stored traceparent stays
            return await self._producer.send(
                topic,
                key=key.encode(),
                value=json.dumps(payload, separators=(",", ":")).encode(),
                headers=[(name, value.encode()) for name, value in carrier.items()],
            )
