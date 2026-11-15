"""JSON-lines logging to stdout, with the active trace id when there is one."""

import json
import logging
import sys
from datetime import UTC, datetime

from opentelemetry import trace

# Attributes every LogRecord has; anything else came from `extra=` and is logged as a field.
_STANDARD_ATTRS = frozenset(vars(logging.makeLogRecord({}))) | {"message", "asctime", "taskName"}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        span_context = trace.get_current_span().get_span_context()
        if span_context.is_valid:
            entry["trace_id"] = format(span_context.trace_id, "032x")
        for key, value in vars(record).items():
            if key not in _STANDARD_ATTRS:
                entry[key] = value
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def setup_logging(level: str) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    # Client libraries are chatty at INFO (every reconnect, every rebalance step).
    for noisy in ("aiokafka", "kafka"):
        logging.getLogger(noisy).setLevel(max(root.level, logging.WARNING))
