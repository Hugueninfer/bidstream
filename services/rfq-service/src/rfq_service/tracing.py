"""OpenTelemetry wiring. Tracing is optional: with OTEL_EXPORTER_OTLP_ENDPOINT
unset the API stays a no-op, and a broken exporter must never fail a request."""

import logging
from collections.abc import Callable, Iterable

from opentelemetry import context, propagate, trace

from .config import Settings

log = logging.getLogger(__name__)
tracer = trace.get_tracer("rfq-service")


def setup_tracing(settings: Settings) -> Callable[[], None]:
    """Install the SDK and gRPC instrumentation; returns a shutdown hook.

    Must run before gRPC servers or channels are created, because the
    instrumentation works by wrapping their constructors."""
    if not settings.otel_endpoint:
        return lambda: None
    try:
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.grpc import (
            GrpcAioInstrumentorClient,
            GrpcAioInstrumentorServer,
        )
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        provider = TracerProvider(resource=Resource.create({"service.name": settings.service_name}))
        # The exporter reads OTEL_EXPORTER_OTLP_ENDPOINT itself and appends /v1/traces.
        provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
        trace.set_tracer_provider(provider)
        GrpcAioInstrumentorServer().instrument()
        GrpcAioInstrumentorClient().instrument()
    except Exception:
        log.warning("tracing disabled: setup failed", exc_info=True)
        return lambda: None
    log.info("tracing enabled", extra={"otlp_endpoint": settings.otel_endpoint})
    return provider.shutdown


def current_traceparent() -> str | None:
    carrier: dict[str, str] = {}
    propagate.inject(carrier)
    return carrier.get("traceparent")


def context_from_kafka_headers(headers: Iterable[tuple[str, bytes]] | None) -> context.Context:
    carrier = {}
    for key, value in headers or ():
        try:
            carrier[key] = value.decode()
        except (UnicodeDecodeError, AttributeError):
            continue
    return propagate.extract(carrier)


def context_from_traceparent(traceparent: str | None) -> context.Context:
    return propagate.extract({"traceparent": traceparent} if traceparent else {})
