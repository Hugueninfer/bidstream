from datetime import timedelta
from decimal import Decimal

import pytest

from rfq_service.errors import FailedPrecondition, InvalidArgument, NotFound, Unavailable
from rfq_service.service import RfqService
from tests.fakes import NOW, FakeBids, FakeStore, FixedClock, make_bid, make_rfq


def service_with(*rfqs, bids=None):
    store = FakeStore(*rfqs)
    return RfqService(store, bids or FakeBids(), clock=FixedClock()), store


class TestCreate:
    async def test_writes_rfq_and_rfq_created_event_together(self):
        service, store = service_with()
        rfq = await service.create(
            tenant_id="tenant_demo",
            title="M8 bolts",
            sku="BOLT-M8",
            quantity=40_000,
            unit="pcs",
            deadline="2026-11-16T17:00:00Z",
        )
        assert await store.get("tenant_demo", rfq.rfq_id) == rfq
        [event] = store.outbox
        assert event.payload["event_type"] == "rfq.created"
        assert event.key == rfq.rfq_id

    async def test_invalid_input_writes_nothing(self):
        service, store = service_with()
        with pytest.raises(InvalidArgument):
            await service.create(
                tenant_id="t", title="M8", sku="", quantity=0, unit="pcs", deadline="soon"
            )
        assert store.rfqs == {} and store.outbox == []


class TestGetAndList:
    async def test_get_is_scoped_to_the_tenant(self):
        rfq = make_rfq()
        service, _ = service_with(rfq)
        assert await service.get(tenant_id=rfq.tenant_id, rfq_id=rfq.rfq_id) == rfq
        with pytest.raises(NotFound):
            await service.get(tenant_id="someone_else", rfq_id=rfq.rfq_id)

    async def test_get_requires_ids(self):
        service, _ = service_with()
        with pytest.raises(InvalidArgument):
            await service.get(tenant_id="", rfq_id="rfq_0123456789ab")

    async def test_list_rejects_unknown_status(self):
        service, _ = service_with()
        with pytest.raises(InvalidArgument):
            await service.list(tenant_id="tenant_test", status="closed")


class TestAward:
    async def test_awards_an_open_rfq_and_emits_rfq_awarded(self):
        rfq = make_rfq()
        bid = make_bid(rfq)
        service, store = service_with(rfq, bids=FakeBids(bid))

        awarded = await service.award(tenant_id=rfq.tenant_id, rfq_id=rfq.rfq_id, bid_id=bid.bid_id)

        assert awarded.status == "awarded"
        assert awarded.awarded_bid_id == bid.bid_id
        assert awarded.awarded_supplier_name == "Kestrel Fastening Co."
        assert awarded.awarded_unit_price == Decimal("0.39")
        assert awarded.awarded_at == NOW
        [event] = store.outbox
        assert event.payload["event_type"] == "rfq.awarded"
        assert event.payload["data"]["bid_id"] == bid.bid_id

    async def test_awarding_after_the_deadline_is_allowed(self):
        rfq = make_rfq(deadline=NOW - timedelta(days=1))
        bid = make_bid(rfq)
        service, _ = service_with(rfq, bids=FakeBids(bid))
        awarded = await service.award(tenant_id=rfq.tenant_id, rfq_id=rfq.rfq_id, bid_id=bid.bid_id)
        assert awarded.status == "awarded"

    async def test_same_bid_twice_is_idempotent_without_calling_bid_service(self):
        rfq = make_rfq()
        bid = make_bid(rfq)
        bids = FakeBids(bid)
        service, store = service_with(rfq, bids=bids)

        first = await service.award(tenant_id=rfq.tenant_id, rfq_id=rfq.rfq_id, bid_id=bid.bid_id)
        bids.unavailable = True  # a retry must not depend on bid-service
        second = await service.award(tenant_id=rfq.tenant_id, rfq_id=rfq.rfq_id, bid_id=bid.bid_id)

        assert second == first
        assert bids.calls == 1
        assert len(store.outbox) == 1

    async def test_awarding_a_different_bid_after_award_fails(self):
        rfq = make_rfq()
        winner = make_bid(rfq)
        other = make_bid(rfq, bid_id="bid_bbbbbbbbbbbb")
        service, _ = service_with(rfq, bids=FakeBids(winner, other))
        await service.award(tenant_id=rfq.tenant_id, rfq_id=rfq.rfq_id, bid_id=winner.bid_id)
        with pytest.raises(FailedPrecondition, match="already awarded"):
            await service.award(tenant_id=rfq.tenant_id, rfq_id=rfq.rfq_id, bid_id=other.bid_id)

    async def test_unknown_rfq(self):
        service, _ = service_with()
        with pytest.raises(NotFound, match="rfq"):
            await service.award(tenant_id="t", rfq_id="rfq_000000000000", bid_id="bid_x")

    async def test_unknown_bid(self):
        rfq = make_rfq()
        service, store = service_with(rfq)
        with pytest.raises(NotFound, match="bid"):
            await service.award(tenant_id=rfq.tenant_id, rfq_id=rfq.rfq_id, bid_id="bid_missing")
        assert store.outbox == []

    async def test_bid_from_another_rfq(self):
        rfq = make_rfq()
        foreign = make_bid(rfq, rfq_id="rfq_ffffffffffff")
        service, store = service_with(rfq, bids=FakeBids(foreign))
        with pytest.raises(FailedPrecondition, match="belongs to rfq rfq_ffffffffffff"):
            await service.award(tenant_id=rfq.tenant_id, rfq_id=rfq.rfq_id, bid_id=foreign.bid_id)
        assert (await store.get(rfq.tenant_id, rfq.rfq_id)).status == "open"

    async def test_bid_service_down(self):
        rfq = make_rfq()
        service, _ = service_with(rfq, bids=FakeBids(unavailable=True))
        with pytest.raises(Unavailable):
            await service.award(tenant_id=rfq.tenant_id, rfq_id=rfq.rfq_id, bid_id="bid_x")

    async def test_requires_all_ids(self):
        service, _ = service_with()
        with pytest.raises(InvalidArgument, match="bid_id"):
            await service.award(tenant_id="t", rfq_id="rfq_000000000000", bid_id="")

    async def test_losing_a_race_to_the_same_bid_returns_the_award(self):
        rfq = make_rfq()
        bid = make_bid(rfq)
        service, store = service_with(rfq, bids=FakeBids(bid))
        store.award_race_winner = bid
        awarded = await service.award(tenant_id=rfq.tenant_id, rfq_id=rfq.rfq_id, bid_id=bid.bid_id)
        assert awarded.awarded_bid_id == bid.bid_id
        assert store.outbox == []  # the winner wrote the event, not us

    async def test_losing_a_race_to_another_bid_fails(self):
        rfq = make_rfq()
        ours = make_bid(rfq)
        theirs = make_bid(rfq, bid_id="bid_bbbbbbbbbbbb")
        service, store = service_with(rfq, bids=FakeBids(ours, theirs))
        store.award_race_winner = theirs
        with pytest.raises(FailedPrecondition):
            await service.award(tenant_id=rfq.tenant_id, rfq_id=rfq.rfq_id, bid_id=ours.bid_id)
