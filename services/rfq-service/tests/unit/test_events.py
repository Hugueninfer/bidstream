import uuid
from datetime import UTC, datetime
from decimal import Decimal

from rfq_service import events
from rfq_service.events import build_envelope
from tests.fakes import NOW, make_bid, make_rfq


def test_envelope_shape():
    envelope = build_envelope(
        event_type="rfq.created",
        tenant_id="tenant_demo",
        key="rfq_0123456789ab",
        data={"a": 1},
        occurred_at=datetime(2026, 11, 14, 14, 2, 11, 500_000, tzinfo=UTC),
    )
    assert set(envelope) == {
        "event_id",
        "event_type",
        "version",
        "occurred_at",
        "tenant_id",
        "key",
        "data",
    }
    assert uuid.UUID(envelope["event_id"]).version == 4
    assert envelope["event_type"] == "rfq.created"
    assert envelope["version"] == 1
    assert envelope["occurred_at"] == "2026-11-14T14:02:11Z"
    assert envelope["key"] == "rfq_0123456789ab"
    assert envelope["data"] == {"a": 1}


def test_every_envelope_gets_a_fresh_event_id():
    rfq = make_rfq()
    assert events.rfq_created(rfq).event_id != events.rfq_created(rfq).event_id


def test_rfq_created_event():
    rfq = make_rfq()
    event = events.rfq_created(rfq)
    assert event.topic == "rfq.events"
    assert event.key == rfq.rfq_id
    assert event.payload["event_id"] == event.event_id
    assert event.payload["event_type"] == "rfq.created"
    assert event.payload["tenant_id"] == rfq.tenant_id
    assert event.payload["data"] == {
        "rfq_id": rfq.rfq_id,
        "tenant_id": rfq.tenant_id,
        "title": "M8 bolts",
        "sku": "BOLT-M8",
        "quantity": 40_000,
        "unit": "pcs",
        "deadline": "2026-11-17T12:00:00Z",
        "created_at": "2026-11-14T11:00:00Z",
    }
    assert event.headers == {"event_type": "rfq.created"}


def test_rfq_awarded_event():
    rfq = make_rfq()
    bid = make_bid(rfq, unit_price=Decimal("0.3900"))
    event = events.rfq_awarded(rfq, bid, NOW)
    assert event.payload["event_type"] == "rfq.awarded"
    assert event.payload["occurred_at"] == "2026-11-14T12:00:00Z"
    assert event.payload["data"] == {
        "rfq_id": rfq.rfq_id,
        "tenant_id": rfq.tenant_id,
        "sku": "BOLT-M8",
        "quantity": 40_000,
        "bid_id": bid.bid_id,
        "supplier_id": "sup_kestrel_fastening_co",
        "supplier_name": "Kestrel Fastening Co.",
        "unit_price": 0.39,
        "awarded_at": "2026-11-14T12:00:00Z",
    }


def test_traceparent_is_carried_in_headers_when_present():
    traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
    event = events.rfq_created(make_rfq(), traceparent=traceparent)
    assert event.headers == {"event_type": "rfq.created", "traceparent": traceparent}
