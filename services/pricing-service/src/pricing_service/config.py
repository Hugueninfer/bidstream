"""Runtime configuration, read once from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    grpc_port: int
    database_url: str
    redis_url: str
    kafka_brokers: str
    service_name: str
    otlp_endpoint: str | None
    log_level: str

    @classmethod
    def from_env(cls) -> Settings:
        return cls(
            grpc_port=int(os.environ.get("GRPC_PORT", "50063")),
            database_url=os.environ.get(
                "DATABASE_URL", "postgresql://bidstream:bidstream@localhost:55432/pricing"
            ),
            redis_url=os.environ.get("REDIS_URL", "redis://localhost:56379/0"),
            kafka_brokers=os.environ.get("KAFKA_BROKERS", "localhost:19092"),
            service_name=os.environ.get("OTEL_SERVICE_NAME", "pricing-service"),
            otlp_endpoint=os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") or None,
            log_level=os.environ.get("LOG_LEVEL", "info"),
        )
