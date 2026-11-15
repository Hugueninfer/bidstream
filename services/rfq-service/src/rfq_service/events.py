"""Event envelopes (docs/contracts.md#events-kafka) and the outbox rows that carry them."""

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .domain import BidInfo, RfqRecord, format_ts

RFQ_EVENTS_TOPIC = "rfq.events"
ENVELOPE_VERSION = 1


@dataclass(frozen=True)
class OutboxEvent:
    """An event waiting in the `outbox` table to be relayed to Kafka."""

    event_id: str
    topic: str
    key: str
    payload: dict[str, Any]
    headers: dict[str, str] = field(default_factory=dict)


def build_envelope(
    *,
    event_type: str,
    tenant_id: str,
    key: str,
    data: dict[str, Any],
    occurred_at: datetime,
    event_id: str | None = None,
) -> dict[str, Any]:
    return {
        "event_id": event_id or str(uuid.uuid4()),
        "event_type": event_type,
        "version": ENVELOPE_VERSION,
        "occurred_at": format_ts(occurred_at),
        "tenant_id": tenant_id,
        "key": key,
        "data": data,
    }


def _outbox_event(
    event_type: str,
    rfq: RfqRecord,
    data: dict[str, Any],
    occurred_at: datetime,
    traceparent: str | None,
) -> OutboxEvent:
    envelope = build_envelope(
        event_type=event_type,
        tenant_id=rfq.tenant_id,
        key=rfq.rfq_id,
        data=data,
        occurred_at=occurred_at,
    )
    headers = {"event_type": event_type}
    if traceparent:
        headers["traceparent"] = traceparent
    return OutboxEvent(
        event_id=envelope["event_id"],
        topic=RFQ_EVENTS_TOPIC,
        key=rfq.rfq_id,
        payload=envelope,
        headers=headers,
    )


def rfq_created(rfq: RfqRecord, traceparent: str | None = None) -> OutboxEvent:
    data = {
        "rfq_id": rfq.rfq_id,
        "tenant_id": rfq.tenant_id,
        "title": rfq.title,
        "sku": rfq.sku,
        "quantity": rfq.quantity,
        "unit": rfq.unit,
        "deadline": format_ts(rfq.deadline),
        "created_at": format_ts(rfq.created_at),
    }
    return _outbox_event("rfq.created", rfq, data, rfq.created_at, traceparent)


def rfq_awarded(
    rfq: RfqRecord, bid: BidInfo, awarded_at: datetime, traceparent: str | None = None
) -> OutboxEvent:
    data = {
        "rfq_id": rfq.rfq_id,
        "tenant_id": rfq.tenant_id,
        "sku": rfq.sku,
        "quantity": rfq.quantity,
        "bid_id": bid.bid_id,
        "supplier_id": bid.supplier_id,
        "supplier_name": bid.supplier_name,
        "unit_price": float(bid.unit_price),
        "awarded_at": format_ts(awarded_at),
    }
    return _outbox_event("rfq.awarded", rfq, data, awarded_at, traceparent)
