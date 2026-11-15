import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type TextMapGetter,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import type { Logger } from './logger.js';

// Tracing is opt-in: without OTEL_EXPORTER_OTLP_ENDPOINT nothing is registered
// and every helper below runs against the no-op API (no spans, no traceparent).
//
// Spans are created by hand (gRPC server, Kafka consumer) instead of through
// auto-instrumentation: this is an ESM app and require-hook based
// instrumentations do not see ESM imports without an experimental loader.

export interface Telemetry {
  shutdown(): Promise<void>;
}

export function startTelemetry(opts: {
  serviceName: string;
  endpoint: string | undefined;
  logger: Logger;
}): Telemetry {
  if (!opts.endpoint) return { shutdown: async () => {} };
  try {
    const sdk = new NodeSDK({
      serviceName: opts.serviceName,
      // Reads OTEL_EXPORTER_OTLP_ENDPOINT and appends /v1/traces.
      traceExporter: new OTLPTraceExporter(),
      instrumentations: [],
      // Only traces are exported (Jaeger has no metrics/logs endpoint).
      metricReaders: [],
      logRecordProcessors: [],
    });
    sdk.start();
    opts.logger.info({ endpoint: opts.endpoint }, 'tracing enabled');
    return {
      shutdown: () =>
        sdk.shutdown().catch((err: unknown) => opts.logger.warn({ err }, 'tracing shutdown failed')),
    };
  } catch (err) {
    opts.logger.warn({ err }, 'tracing disabled: SDK failed to start');
    return { shutdown: async () => {} };
  }
}

export const tracer = trace.getTracer('bid-service');

type Carrier = Record<string, string | Buffer | (string | Buffer)[] | undefined>;

const carrierGetter: TextMapGetter<Carrier> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => {
    const value = carrier[key];
    const first = Array.isArray(value) ? value[0] : value;
    return first === undefined ? undefined : first.toString();
  },
};

/** Parent context from incoming headers (gRPC metadata, Kafka headers). Never throws. */
export function extractContext(carrier: Carrier): Context {
  try {
    return propagation.extract(ROOT_CONTEXT, carrier, carrierGetter);
  } catch {
    return ROOT_CONTEXT;
  }
}

/** W3C trace headers (traceparent, tracestate) for the active span; empty when tracing is off. */
export function currentTraceHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    propagation.inject(context.active(), headers);
  } catch {
    // Tracing must never break a request.
  }
  return headers;
}

/**
 * Runs `fn` inside a span. The span records exceptions and is always ended;
 * the original error (if any) is rethrown untouched.
 */
export async function withSpan<T>(
  name: string,
  options: { kind: SpanKind; parent?: Context; attributes?: Attributes },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = options.parent ?? context.active();
  const span = tracer.startSpan(name, { kind: options.kind, attributes: options.attributes }, parent);
  try {
    return await context.with(trace.setSpan(parent, span), () => fn(span));
  } catch (err) {
    span.recordException(err instanceof Error ? err : String(err));
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw err;
  } finally {
    span.end();
  }
}

export { SpanKind, SpanStatusCode };
