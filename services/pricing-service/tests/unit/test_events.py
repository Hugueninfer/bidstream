import json
import uuid
from decimal import Decimal

import pytest

from fakes import DownRedis, FakeAwardStore, FakeRedis
from pricing_service.cache import PriceCache
from pricing_service.events import AwardHandler, Outcome, PoisonMessage


def envelope(event_type="rfq.awarded", **data_overrides) -> bytes:
    data = {
        "rfq_id": "rfq_7f3a91c2b0de",
        "tenant_id": "tenant_demo",
        "sku": "BOLT-M8",
        "quantity": 40_000,
        "bid_id": "bid_0123456789ab",
        "supplier_id": "sup_kestrel_fastening_co",
        "supplier_name": "Kestrel Fastening Co.",
        "unit_price": 0.39,
        "awarded_at": "2026-11-14T14:02:11Z",
    }
    data.update(data_overrides)
    return json.dumps(
        {
            "event_id": str(uuid.uuid4()),
            "event_type": event_type,
            "version": 1,
            "occurred_at": "2026-11-14T14:02:11Z",
            "tenant_id": "tenant_demo",
            "key": "rfq_7f3a91c2b0de",
            "data": data,
        }
    ).encode()


@pytest.fixture
def store() -> FakeAwardStore:
    return FakeAwardStore()


@pytest.fixture
def redis() -> FakeRedis:
    return FakeRedis()


@pytest.fixture
def handler(store, redis) -> AwardHandler:
    return AwardHandler(store, PriceCache(redis))


@pytest.mark.parametrize("event_type", ["rfq.created", "rfq.expired", "something.new"])
async def test_other_event_types_are_ignored(handler, store, redis, event_type):
    assert await handler.handle(envelope(event_type)) is Outcome.IGNORED
    assert store.awards == []
    assert redis.data == {}


async def test_award_is_recorded_and_bumps_the_version(handler, store, redis):
    assert await handler.handle(envelope()) is Outcome.APPLIED

    [award] = store.awards
    assert (award.sku, award.quantity, award.unit_price) == ("BOLT-M8", 40_000, Decimal("0.39"))
    assert award.awarded_at.tzinfo is not None
    assert redis.data["price:ver:BOLT-M8"] == "1"


async def test_duplicate_award_does_not_bump_twice(handler, store, redis):
    message = envelope()
    assert await handler.handle(message) is Outcome.APPLIED
    assert await handler.handle(message) is Outcome.DUPLICATE
    assert len(store.awards) == 1
    assert redis.data["price:ver:BOLT-M8"] == "1"


@pytest.mark.parametrize(
    "raw",
    [
        b"not json",
        b"[1, 2]",
        None,
        envelope(quantity=0),
        envelope(unit_price="abc"),
        envelope(sku=""),
        envelope(awarded_at="yesterday"),
        envelope(awarded_at="2026-11-14T14:02:11"),
        json.dumps({"event_id": "nope", "event_type": "rfq.awarded", "data": {}}).encode(),
    ],
)
async def test_malformed_messages_are_poison(handler, raw):
    with pytest.raises(PoisonMessage):
        await handler.handle(raw)


async def test_version_bump_is_retried_after_commit(store):
    redis = DownRedis(fail_times=2)
    handler = AwardHandler(store, PriceCache(redis), bump_delays=(0, 0, 0))

    assert await handler.handle(envelope()) is Outcome.APPLIED
    assert redis.calls == 3


async def test_version_bump_gives_up_without_failing_the_event(store):
    redis = DownRedis()
    handler = AwardHandler(store, PriceCache(redis), bump_delays=(0, 0, 0))

    assert await handler.handle(envelope()) is Outcome.APPLIED
    assert redis.calls == 4
