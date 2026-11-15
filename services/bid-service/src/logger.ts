import { isSpanContextValid, trace } from '@opentelemetry/api';
import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string, service = 'bid-service'): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Correlate log lines with traces when a span is active.
    mixin() {
      const ctx = trace.getActiveSpan()?.spanContext();
      if (!ctx || !isSpanContextValid(ctx)) return {};
      return { trace_id: ctx.traceId, span_id: ctx.spanId };
    },
  });
}
