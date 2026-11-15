"""Turning bid.events messages into read-model updates (no Kafka code here)."""

import json
import logging
import uuid
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any, Literal, Protocol

log = logging.getLogger(__name__)

CONSUMER_NAME = "rfq-service"
_PRICE_SCALE = Decimal("0.0001")  # NUMERIC(12,4)

Outcome = Literal["applied", "duplicate", "ignored"]


class PermanentError(Exception):
    """The message can never be processed (malformed, or refers to nothing we know).
    Retrying is pointless, so it goes straight to the DLQ."""


@dataclass(frozen=True)
class BidSubmitted:
    event_id: str
    tenant_id: str
    rfq_id: str
    bid_id: str
    supplier_name: str
    unit_price: Decimal


class BidReadModel(Protocol):
    async def apply_bid_submitted(self, bid: BidSubmitted, consumer: str) -> bool: ...


def decode_envelope(value: bytes | None) -> dict[str, Any]:
    try:
        envelope = json.loads(value or b"")
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise PermanentError(f"message is not valid JSON: {exc}") from exc
    if not isinstance(envelope, dict) or not isinstance(envelope.get("event_type"), str):
        raise PermanentError("message is not an event envelope (no event_type)")
    return envelope


def parse_bid_submitted(envelope: dict[str, Any]) -> BidSubmitted:
    data = envelope.get("data")
    if not isinstance(data, dict):
        raise PermanentError("bid.submitted without a data object")
    try:
        event_id = str(uuid.UUID(str(envelope["event_id"])))
        unit_price = Decimal(str(data["unit_price"])).quantize(_PRICE_SCALE)
        bid = BidSubmitted(
            event_id=event_id,
            tenant_id=_text(envelope.get("tenant_id") or data["tenant_id"]),
            rfq_id=_text(data["rfq_id"]),
            bid_id=_text(data["bid_id"]),
            supplier_name=_text(data["supplier_name"]),
            unit_price=unit_price,
        )
    except KeyError as exc:
        raise PermanentError(f"bid.submitted is missing field {exc}") from exc
    except (ValueError, TypeError, InvalidOperation) as exc:
        raise PermanentError(f"bid.submitted has an invalid field: {exc}") from exc
    if not unit_price.is_finite() or unit_price <= 0:
        raise PermanentError(f"bid.submitted has a non-positive unit_price {unit_price}")
    return bid


def _text(value: Any) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"expected a non-empty string, got {value!r}")
    return value


class BidEventsHandler:
    def __init__(self, read_model: BidReadModel) -> None:
        self._read_model = read_model

    async def handle(self, value: bytes | None) -> Outcome:
        envelope = decode_envelope(value)
        event_type = envelope["event_type"]
        if event_type != "bid.submitted":
            return "ignored"  # forward compatibility: unknown types are not errors
        bid = parse_bid_submitted(envelope)
        applied = await self._read_model.apply_bid_submitted(bid, CONSUMER_NAME)
        outcome: Outcome = "applied" if applied else "duplicate"
        log.info(
            "bid event handled",
            extra={
                "event_id": bid.event_id,
                "rfq_id": bid.rfq_id,
                "bid_id": bid.bid_id,
                "outcome": outcome,
            },
        )
        return outcome
