"""Process wiring and lifecycle: start everything, then shut down cleanly on SIGTERM."""

import asyncio
import contextlib
import logging
import signal

import grpc
from aiokafka import AIOKafkaProducer
from aiokafka.errors import KafkaConnectionError
from bidstream.rfq.v1 import rfq_pb2, rfq_pb2_grpc
from grpc_health.v1 import health, health_pb2, health_pb2_grpc
from grpc_reflection.v1alpha import reflection

from .aio import sleep_or_stop
from .bid_client import GrpcBidClient
from .bid_events import CONSUMER_NAME, BidEventsHandler
from .config import Settings
from .consumer import BidEventsConsumer
from .db import create_pool
from .grpc_api import RfqServicer
from .migrations import apply_migrations
from .outbox_relay import OutboxRelay
from .service import RfqService
from .store import PgRfqStore
from .tracing import setup_tracing

log = logging.getLogger(__name__)

RFQ_SERVICE_NAME = rfq_pb2.DESCRIPTOR.services_by_name["RfqService"].full_name
SERVER_GRACE_S = 5.0
WORKER_STOP_TIMEOUT_S = 10.0
STARTUP_TIMEOUT_S = 60.0


async def run(settings: Settings) -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)

    async with contextlib.AsyncExitStack() as stack:
        # Cleanups run in reverse order of registration.
        stack.callback(setup_tracing(settings))  # before any gRPC server/channel exists

        pool = create_pool(settings.database_url)
        await pool.open(wait=True, timeout=STARTUP_TIMEOUT_S)
        stack.push_async_callback(pool.close)
        applied = await apply_migrations(pool)
        log.info("database ready", extra={"migrations_applied": applied})

        producer = await _start_producer(settings.kafka_brokers, stop)
        stack.push_async_callback(producer.stop)  # flushes anything still buffered

        bid_channel = grpc.aio.insecure_channel(settings.bid_service_addr)
        stack.push_async_callback(bid_channel.close)

        store = PgRfqStore(pool)
        workers = [
            asyncio.create_task(OutboxRelay(pool, producer).run(stop), name="outbox-relay"),
            asyncio.create_task(
                BidEventsConsumer(
                    brokers=settings.kafka_brokers,
                    handler=BidEventsHandler(store),
                    producer=producer,
                ).run(stop),
                name="bid-events-consumer",
            ),
        ]
        stack.push_async_callback(_stop_workers, workers)
        stack.callback(stop.set)  # also stops the workers when unwinding after an error

        service = RfqService(store, GrpcBidClient(bid_channel))
        server, health_servicer = await _start_grpc_server(service, settings.grpc_port)
        stack.push_async_callback(_stop_grpc_server, server, health_servicer)

        log.info("rfq-service started", extra={"grpc_port": settings.grpc_port})
        await stop.wait()
        log.info("shutting down")
    log.info("rfq-service stopped")


async def _start_producer(brokers: str, stop: asyncio.Event) -> AIOKafkaProducer:
    """Kafka may still be starting (compose, k8s): retry with backoff for a while."""
    deadline = asyncio.get_running_loop().time() + STARTUP_TIMEOUT_S
    delay = 0.5
    while True:
        producer = AIOKafkaProducer(
            bootstrap_servers=brokers,
            client_id=CONSUMER_NAME,
            enable_idempotence=True,  # acks=all, and retries can't duplicate or reorder
            linger_ms=5,
        )
        try:
            await producer.start()
            return producer
        except KafkaConnectionError:
            await producer.stop()
            if stop.is_set() or asyncio.get_running_loop().time() > deadline:
                raise
            log.warning("kafka not reachable yet; retrying", extra={"retry_in_s": delay})
            await sleep_or_stop(stop, delay)
            delay = min(delay * 2, 5.0)


async def _start_grpc_server(
    service: RfqService, port: int
) -> tuple[grpc.aio.Server, health.aio.HealthServicer]:
    server = grpc.aio.server()
    rfq_pb2_grpc.add_RfqServiceServicer_to_server(RfqServicer(service), server)

    health_servicer = health.aio.HealthServicer()
    health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)
    reflection.enable_server_reflection(
        (RFQ_SERVICE_NAME, health.SERVICE_NAME, reflection.SERVICE_NAME), server
    )

    server.add_insecure_port(f"[::]:{port}")
    await server.start()
    for name in ("", RFQ_SERVICE_NAME):
        await health_servicer.set(name, health_pb2.HealthCheckResponse.SERVING)
    return server, health_servicer


async def _stop_grpc_server(
    server: grpc.aio.Server, health_servicer: health.aio.HealthServicer
) -> None:
    """Report NOT_SERVING so load balancers drain us, then let in-flight RPCs finish."""
    await health_servicer.enter_graceful_shutdown()
    await server.stop(SERVER_GRACE_S)


async def _stop_workers(workers: list[asyncio.Task[None]]) -> None:
    """Workers watch the stop event and finish their current batch; cancel stragglers."""
    _, pending = await asyncio.wait(workers, timeout=WORKER_STOP_TIMEOUT_S)
    for task in pending:
        log.warning("worker did not stop in time; cancelling", extra={"worker": task.get_name()})
        task.cancel()
    await asyncio.gather(*workers, return_exceptions=True)
