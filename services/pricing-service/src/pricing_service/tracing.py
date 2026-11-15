"""OpenTelemetry setup. Tracing is optional: any failure here only disables it."""

from __future__ import annotations

import logging

from opentelemetry import trace
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider

log = logging.getLogger(__name__)


def setup_tracing(service_name: str, otlp_endpoint: str | None) -> TracerProvider | None:
    """Install a global tracer provider exporting OTLP/HTTP, or do nothing if no endpoint."""
    if not otlp_endpoint:
        return None
    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        provider = TracerProvider(resource=Resource.create({SERVICE_NAME: service_name}))
        exporter = OTLPSpanExporter(endpoint=f"{otlp_endpoint.rstrip('/')}/v1/traces")
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        log.info("tracing enabled", extra={"otlp_endpoint": otlp_endpoint})
        return provider
    except Exception:
        log.warning("tracing setup failed; continuing without it", exc_info=True)
        return None


def grpc_server_interceptors() -> list:
    """Server interceptors that create a span per RPC (empty if instrumentation is unavailable)."""
    try:
        from opentelemetry.instrumentation.grpc import aio_server_interceptor

        return [aio_server_interceptor()]
    except Exception:
        log.warning("grpc instrumentation unavailable", exc_info=True)
        return []


def shutdown_tracing(provider: TracerProvider | None) -> None:
    if provider is None:
        return
    try:
        provider.shutdown()
    except Exception:
        log.warning("tracing shutdown failed", exc_info=True)
