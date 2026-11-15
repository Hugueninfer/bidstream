import json
from decimal import Decimal

import pytest

from rfq_service.bid_events import (
    CONSUMER_NAME,
    BidEventsHandler,
    BidSubmitted,
    PermanentError,
    decode_envelope,
    parse_bid_submitted,
)

EVENT_ID = "8a1f5c6e-1b2c-4d3e-8f90-123456789abc"


def bid_submitted(**data_overrides: object) -> dict:
    data = {
        "bid_id": "bid_aaaaaaaaaaaa",
        "rfq_id": "rfq_0123456789ab",
        "tenant_id": "tenant_demo",
        "supplier_id": "sup_kestrel_fastening_co",
        "supplier_name": "Kestrel Fastening Co.",
        "unit_price": 0.39,
        "currency": "USD",
        "lead_time_days": 21,
        "submitted_at": "2026-11-14T14:02:11Z",
    }
    data.update(data_overrides)
    return {
        "event_id": EVENT_ID,
        "event_type": "bid.submitted",
        "version": 1,
        "occurred_at": "2026-11-14T14:02:11Z",
        "tenant_id": "tenant_demo",
        "key": "rfq_0123456789ab",
        "data": data,
    }


class RecordingReadModel:
    def __init__(self) -> None:
        self.seen: set[str] = set()
        self.applied: list[BidSubmitted] = []

    async def apply_bid_submitted(self, bid: BidSubmitted, consumer: str) -> bool:
        assert consumer == CONSUMER_NAME
        if bid.event_id in self.seen:
            return False
        self.seen.add(bid.event_id)
        self.applied.append(bid)
        return True


def test_parse_bid_submitted():
    bid = parse_bid_submitted(bid_submitted())
    assert bid == BidSubmitted(
        event_id=EVENT_ID,
        tenant_id="tenant_demo",
        rfq_id="rfq_0123456789ab",
        bid_id="bid_aaaaaaaaaaaa",
        supplier_name="Kestrel Fastening Co.",
        unit_price=Decimal("0.3900"),
    )


def test_price_is_rounded_to_the_column_scale():
    assert parse_bid_submitted(bid_submitted(unit_price=0.123456)).unit_price == Decimal("0.1235")


@pytest.mark.parametrize(
    "envelope",
    [
        {**bid_submitted(), "event_id": "not-a-uuid"},
        {**bid_submitted(), "data": None},
        bid_submitted(unit_price="cheap"),
        bid_submitted(unit_price=0),
        bid_submitted(unit_price=-1),
        bid_submitted(rfq_id=""),
        bid_submitted(supplier_name=None),
    ],
)
def test_malformed_bid_submitted_is_permanent(envelope):
    with pytest.raises(PermanentError):
        parse_bid_submitted(envelope)


def test_missing_field_is_permanent():
    envelope = bid_submitted()
    del envelope["data"]["rfq_id"]
    with pytest.raises(PermanentError, match="rfq_id"):
        parse_bid_submitted(envelope)


@pytest.mark.parametrize("value", [b"", b"{nope", b"[]", b'{"data": {}}', None])
def test_non_envelopes_are_permanent(value):
    with pytest.raises(PermanentError):
        decode_envelope(value)


async def test_handler_applies_then_skips_duplicates():
    read_model = RecordingReadModel()
    handler = BidEventsHandler(read_model)
    message = json.dumps(bid_submitted()).encode()
    assert await handler.handle(message) == "applied"
    assert await handler.handle(message) == "duplicate"
    assert len(read_model.applied) == 1


async def test_handler_ignores_unknown_event_types():
    read_model = RecordingReadModel()
    message = json.dumps({**bid_submitted(), "event_type": "bid.withdrawn"}).encode()
    assert await BidEventsHandler(read_model).handle(message) == "ignored"
    assert read_model.applied == []
