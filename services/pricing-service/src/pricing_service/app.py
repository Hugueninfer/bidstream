"""Process wiring: startup order, signal handling and graceful shutdown."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import signal

import grpc
import redis.asyncio as aioredis
from bidstream.pricing.v1 import pricing_pb2_grpc
from grpc_health.v1 import health, health_pb2, health_pb2_grpc
from psycopg_pool import AsyncConnectionPool

from . import db, tracing
from .cache import PriceCache
from .config import Settings
from .consumer import EventConsumer
from .estimator import Estimator
from .events import AwardHandler
from .grpc_api import PricingServicer
from .log import configure_logging

log = logging.getLogger(__name__)

PRICING_SERVICE = "bidstream.pricing.v1.PricingService"
SHUTDOWN_GRACE_SECONDS = 10


async def run(settings: Settings) -> None:
    provider = tracing.setup_tracing(settings.service_name, settings.otlp_endpoint)

    # timeout: how long a request waits for a connection; the gateway gives up at 800 ms anyway.
    pool = AsyncConnectionPool(
        settings.database_url, min_size=1, max_size=10, timeout=2.0, open=False
    )
    await pool.open(wait=True, timeout=60)
    # Short timeouts: Redis is an optimisation and must not eat the gateway's 800 ms budget.
    redis = aioredis.from_url(settings.redis_url, socket_timeout=0.2, socket_connect_timeout=0.2)

    try:
        await db.migrate(pool)
        await db.seed_if_empty(pool)

        repository = db.ObservationRepository(pool)
        cache = PriceCache(redis, settings.model_version)
        consumer = EventConsumer(settings.kafka_brokers, AwardHandler(repository, cache))

        server = grpc.aio.server(interceptors=tracing.grpc_server_interceptors())
        pricing_pb2_grpc.add_PricingServiceServicer_to_server(
            PricingServicer(Estimator(repository, cache, model_version=settings.model_version)),
            server,
        )
        health_servicer = health.aio.HealthServicer()
        health_pb2_grpc.add_HealthServicer_to_server(health_servicer, server)
        server.add_insecure_port(f"[::]:{settings.grpc_port}")
        await server.start()
        for name in ("", PRICING_SERVICE):
            await health_servicer.set(name, health_pb2.HealthCheckResponse.SERVING)
        log.info("grpc server listening", extra={"port": settings.grpc_port})

        consumer_task = asyncio.create_task(consumer.run_forever(), name="rfq-events-consumer")
        await _wait_for_shutdown_signal()

        log.info("shutting down")
        await health_servicer.enter_graceful_shutdown()
        consumer.stop()
        await server.stop(grace=SHUTDOWN_GRACE_SECONDS)
        try:
            await asyncio.wait_for(consumer_task, timeout=SHUTDOWN_GRACE_SECONDS)
        except TimeoutError:
            # Uncommitted message will be redelivered; handling is idempotent.
            consumer_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await consumer_task
    finally:
        await redis.aclose()
        await pool.close()
        tracing.shutdown_tracing(provider)
        log.info("stopped")


async def _wait_for_shutdown_signal() -> None:
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()


def main() -> None:
    settings = Settings.from_env()
    configure_logging(settings.log_level)
    asyncio.run(run(settings))
