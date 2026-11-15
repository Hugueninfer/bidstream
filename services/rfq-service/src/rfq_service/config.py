import os
from collections.abc import Mapping
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    grpc_port: int
    database_url: str
    kafka_brokers: str
    bid_service_addr: str
    log_level: str
    otel_endpoint: str | None
    service_name: str

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "Settings":
        # Defaults match docker-compose so the service runs there with no extra config.
        return cls(
            grpc_port=int(env.get("GRPC_PORT", "50061")),
            database_url=env.get(
                "DATABASE_URL", "postgresql://bidstream:bidstream@postgres:5432/rfq"
            ),
            kafka_brokers=env.get("KAFKA_BROKERS", "redpanda:9092"),
            bid_service_addr=env.get("BID_SERVICE_ADDR", "bid-service:50062"),
            log_level=env.get("LOG_LEVEL", "info"),
            otel_endpoint=env.get("OTEL_EXPORTER_OTLP_ENDPOINT") or None,
            service_name=env.get("OTEL_SERVICE_NAME", "rfq-service"),
        )
