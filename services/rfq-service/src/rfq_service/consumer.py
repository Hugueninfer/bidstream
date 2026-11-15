"""bid.events consumer: retries, dead-lettering and manual offset commits."""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence

import psycopg
from aiokafka import AIOKafkaConsumer, AIOKafkaProducer, ConsumerRecord
from opentelemetry import trace

from .aio import sleep_or_stop
from .bid_events import CONSUMER_NAME, BidEventsHandler, PermanentError
from .tracing import context_from_kafka_headers, tracer

log = logging.getLogger(__name__)

TOPIC = "bid.events"
DLQ_TOPIC = "bid.events.dlq"
RETRY_DELAYS = (0.2, 1.0, 3.0)
_MAX_ERROR_HEADER = 500


class InfrastructureError(Exception):
    """Our own dependency (Postgres) is down. Never dead-letter for this: stop,
    and resume from the last committed offset once it is back."""


async def process_with_retry(
    handle: Callable[[], Awaitable[object]],
    delays: Sequence[float] = RETRY_DELAYS,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> Exception | None:
    """Run `handle`, retrying after each delay. Returns None on success, or the
    last error once retries are exhausted (or immediately for a PermanentError)."""
    last_error: Exception | None = None
    for attempt, delay in enumerate((0.0, *delays)):
        if delay:
            await sleep(delay)
        try:
            await handle()
            return None
        except PermanentError as exc:
            return exc
        except psycopg.OperationalError as exc:
            raise InfrastructureError(str(exc)) from exc
        except Exception as exc:
            last_error = exc
            log.warning("bid event failed", extra={"attempt": attempt + 1, "error": repr(exc)})
    return last_error


def dlq_headers(original: Sequence[tuple[str, bytes]], error: Exception) -> list[tuple[str, bytes]]:
    return [
        *original,
        ("dlq_error", f"{type(error).__name__}: {error}"[:_MAX_ERROR_HEADER].encode()),
        ("dlq_consumer", CONSUMER_NAME.encode()),
    ]


class BidEventsConsumer:
    def __init__(
        self,
        *,
        brokers: str,
        handler: BidEventsHandler,
        producer: AIOKafkaProducer,
        retry_delays: Sequence[float] = RETRY_DELAYS,
    ) -> None:
        self._brokers = brokers
        self._handler = handler
        self._producer = producer
        self._retry_delays = retry_delays

    async def run(self, stop: asyncio.Event) -> None:
        """Consume until `stop` is set. Any crash (Kafka or Postgres down) recreates
        the consumer, which resumes from the last committed offset."""
        backoff = 1.0
        while not stop.is_set():
            consumer = AIOKafkaConsumer(
                TOPIC,
                bootstrap_servers=self._brokers,
                group_id=CONSUMER_NAME,
                client_id=CONSUMER_NAME,
                enable_auto_commit=False,
                auto_offset_reset="earliest",
            )
            try:
                await consumer.start()
                log.info("consumer started", extra={"topic": TOPIC})
                if await self._consume(consumer, stop):
                    backoff = 1.0
            except Exception:
                log.exception("consumer crashed; restarting", extra={"backoff_s": backoff})
            finally:
                await consumer.stop()
            if not stop.is_set():
                await sleep_or_stop(stop, backoff)
                backoff = min(backoff * 2, 30.0)

    async def _consume(self, consumer: AIOKafkaConsumer, stop: asyncio.Event) -> bool:
        progressed = False
        while not stop.is_set():
            batches = await consumer.getmany(timeout_ms=500, max_records=100)
            for tp, messages in batches.items():
                for message in messages:
                    await self._process(message)
                # Commit only after every message up to here was applied or dead-lettered.
                await consumer.commit({tp: messages[-1].offset + 1})
                progressed = True
        return progressed

    async def _process(self, message: ConsumerRecord) -> None:
        parent = context_from_kafka_headers(message.headers)
        with tracer.start_as_current_span(
            f"{TOPIC} process",
            context=parent,
            kind=trace.SpanKind.CONSUMER,
            attributes={
                "messaging.system": "kafka",
                "messaging.destination.name": TOPIC,
                "messaging.kafka.partition": message.partition,
                "messaging.kafka.offset": message.offset,
            },
        ):
            error = await process_with_retry(
                lambda: self._handler.handle(message.value), self._retry_delays
            )
            if error is not None:
                await self._dead_letter(message, error)

    async def _dead_letter(self, message: ConsumerRecord, error: Exception) -> None:
        await self._producer.send_and_wait(
            DLQ_TOPIC,
            value=message.value,
            key=message.key,
            headers=dlq_headers(message.headers or (), error),
        )
        log.error(
            "bid event dead-lettered",
            extra={
                "partition": message.partition,
                "offset": message.offset,
                "error": f"{type(error).__name__}: {error}",
            },
        )
