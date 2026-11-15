"""Kafka consumer for rfq.events: retries, dead-lettering and manual offset commits."""

from __future__ import annotations

import asyncio
import contextlib
import logging

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer, ConsumerRecord
from opentelemetry import propagate, trace
from opentelemetry.trace import SpanKind, Status, StatusCode

from .events import AwardHandler, PoisonMessage

log = logging.getLogger(__name__)
tracer = trace.get_tracer(__name__)

TOPIC = "rfq.events"
DLQ_TOPIC = f"{TOPIC}.dlq"
GROUP_ID = "pricing-service"
RETRY_DELAYS = (0.2, 1.0, 3.0)


class EventConsumer:
    def __init__(
        self, brokers: str, handler: AwardHandler, retry_delays: tuple[float, ...] = RETRY_DELAYS
    ) -> None:
        self._brokers = brokers
        self._handler = handler
        self._retry_delays = retry_delays
        self._stopping = asyncio.Event()

    def stop(self) -> None:
        """Ask the loop to exit after the message in flight is committed."""
        self._stopping.set()

    async def run_forever(self) -> None:
        """Consume until stop(); reconnects with backoff if Kafka goes away."""
        backoff = 1.0
        while not self._stopping.is_set():
            try:
                await self._run_session()
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("consumer crashed; restarting", extra={"backoff_s": backoff})
                await self._sleep_unless_stopping(backoff)
                backoff = min(backoff * 2, 30.0)

    async def _run_session(self) -> None:
        consumer = AIOKafkaConsumer(
            TOPIC,
            bootstrap_servers=self._brokers,
            group_id=GROUP_ID,
            enable_auto_commit=False,
            # A new group replays history: past awards belong in the price history.
            auto_offset_reset="earliest",
        )
        producer = AIOKafkaProducer(bootstrap_servers=self._brokers, acks="all")
        await consumer.start()
        try:
            await producer.start()
            log.info("consumer started", extra={"topic": TOPIC, "group": GROUP_ID})
            while not self._stopping.is_set():
                batches = await consumer.getmany(timeout_ms=500, max_records=100)
                for tp, messages in batches.items():
                    for message in messages:
                        await self._process(message, producer)
                        await consumer.commit({tp: message.offset + 1})
                        if self._stopping.is_set():
                            return
        finally:
            await producer.stop()
            await consumer.stop()

    async def _process(self, message: ConsumerRecord, producer: AIOKafkaProducer) -> None:
        headers = {k: v.decode("utf-8", "replace") for k, v in message.headers or ()}
        parent = propagate.extract(headers)
        with tracer.start_as_current_span(
            f"{TOPIC} process",
            context=parent,
            kind=SpanKind.CONSUMER,
            attributes={
                "messaging.system": "kafka",
                "messaging.destination.name": TOPIC,
                "messaging.kafka.consumer.group": GROUP_ID,
                "messaging.kafka.destination.partition": message.partition,
                "messaging.kafka.message.offset": message.offset,
                "messaging.event_type": headers.get("event_type", ""),
            },
        ) as span:
            error = await self._handle_with_retries(message)
            if error is not None:
                span.set_status(Status(StatusCode.ERROR, error))
                await self._dead_letter(message, producer, error)

    async def _handle_with_retries(self, message: ConsumerRecord) -> str | None:
        """Returns None on success, or the final error description."""
        for attempt, delay in enumerate((*self._retry_delays, None), start=1):
            try:
                outcome = await self._handler.handle(message.value)
                log.debug(
                    "event handled", extra={"outcome": outcome.value, "offset": message.offset}
                )
                return None
            except PoisonMessage as exc:
                # Malformed input won't get better with retries.
                return f"PoisonMessage: {exc}"
            except Exception as exc:
                if delay is None:
                    return f"{type(exc).__name__}: {exc}"
                log.warning(
                    "event handling failed; retrying",
                    extra={
                        "attempt": attempt,
                        "delay_s": delay,
                        "error": repr(exc),
                        "partition": message.partition,
                        "offset": message.offset,
                    },
                )
                await asyncio.sleep(delay)
        raise AssertionError("unreachable")

    async def _dead_letter(
        self, message: ConsumerRecord, producer: AIOKafkaProducer, error: str
    ) -> None:
        headers = [
            *(message.headers or ()),
            ("dlq_error", error[:1000].encode()),
            ("dlq_consumer", GROUP_ID.encode()),
        ]
        # The offset is only committed once the DLQ has the message, so keep trying:
        # losing an event silently is worse than stalling the partition.
        backoff = 1.0
        while True:
            try:
                await producer.send_and_wait(
                    DLQ_TOPIC, value=message.value, key=message.key, headers=headers
                )
                log.error(
                    "event sent to DLQ",
                    extra={
                        "dlq_topic": DLQ_TOPIC,
                        "error": error,
                        "partition": message.partition,
                        "offset": message.offset,
                    },
                )
                return
            except Exception:
                log.exception("DLQ publish failed; retrying", extra={"backoff_s": backoff})
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    async def _sleep_unless_stopping(self, seconds: float) -> None:
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self._stopping.wait(), timeout=seconds)
