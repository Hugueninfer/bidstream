"""rfq-service against a real Postgres: transactions, idempotency, SQL filters."""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from rfq_service import events
from rfq_service.bid_events import CONSUMER_NAME, BidSubmitted, PermanentError
from rfq_service.errors import FailedPrecondition
from rfq_service.migrations import apply_migrations, migration_files
from rfq_service.service import RfqService
from tests.fakes import FakeBids, make_bid, make_rfq

pytestmark = pytest.mark.integration

IN_THREE_DAYS = (datetime.now(UTC) + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ")


async def create_rfq(service: RfqService, tenant: str, title: str = "M8 bolts"):
    return await service.create(
        tenant_id=tenant,
        title=title,
        sku="BOLT-M8",
        quantity=40_000,
        unit="pcs",
        deadline=IN_THREE_DAYS,
    )


async def outbox_rows(pool, rfq_id: str) -> list[tuple]:
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT event_id, topic, key, payload, headers FROM outbox WHERE key = %s ORDER BY id",
            (rfq_id,),
        )
        return await cur.fetchall()


async def test_migrations_are_idempotent_under_concurrency(pool):
    results = await asyncio.gather(*(apply_migrations(pool) for _ in range(3)))
    assert results == [[], [], []]
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT version FROM schema_migrations ORDER BY version")
        versions = [row[0] for row in await cur.fetchall()]
    assert versions == [path.name for path in migration_files()]


async def test_create_writes_rfq_and_outbox_row(pool, store, tenant):
    service = RfqService(store, FakeBids())
    rfq = await create_rfq(service, tenant)

    assert await store.get(tenant, rfq.rfq_id) == rfq
    [(event_id, topic, key, payload, headers)] = await outbox_rows(pool, rfq.rfq_id)
    assert topic == "rfq.events" and key == rfq.rfq_id
    assert str(event_id) == payload["event_id"]
    assert payload["event_type"] == "rfq.created"
    assert payload["tenant_id"] == tenant
    assert payload["data"]["rfq_id"] == rfq.rfq_id
    assert payload["data"]["deadline"] == IN_THREE_DAYS
    assert headers["event_type"] == "rfq.created"


async def test_award_is_idempotent_and_writes_one_event(pool, store, tenant):
    rfq = await create_rfq(RfqService(store, FakeBids()), tenant)
    bid = make_bid(rfq)
    other = make_bid(rfq, bid_id="bid_bbbbbbbbbbbb")
    service = RfqService(store, FakeBids(bid, other))

    first = await service.award(tenant_id=tenant, rfq_id=rfq.rfq_id, bid_id=bid.bid_id)
    second = await service.award(tenant_id=tenant, rfq_id=rfq.rfq_id, bid_id=bid.bid_id)
    with pytest.raises(FailedPrecondition):
        await service.award(tenant_id=tenant, rfq_id=rfq.rfq_id, bid_id=other.bid_id)

    assert first == second
    assert first.status == "awarded"
    assert first.awarded_unit_price == Decimal("0.3900")
    event_types = [row[3]["event_type"] for row in await outbox_rows(pool, rfq.rfq_id)]
    assert event_types == ["rfq.created", "rfq.awarded"]


async def test_concurrent_awards_have_one_winner(pool, store, tenant):
    rfq = await create_rfq(RfqService(store, FakeBids()), tenant)
    bids = [make_bid(rfq, bid_id=f"bid_{i:012x}") for i in range(5)]
    service = RfqService(store, FakeBids(*bids))

    results = await asyncio.gather(
        *(service.award(tenant_id=tenant, rfq_id=rfq.rfq_id, bid_id=b.bid_id) for b in bids),
        return_exceptions=True,
    )

    winners = [r for r in results if not isinstance(r, Exception)]
    assert len(winners) == 1
    assert all(isinstance(r, FailedPrecondition) for r in results if r not in winners)
    awards = [r for r in await outbox_rows(pool, rfq.rfq_id) if r[3]["event_type"] == "rfq.awarded"]
    assert len(awards) == 1


async def test_list_filters_on_effective_status(store, tenant):
    now = datetime.now(UTC)
    open_rfq = make_rfq(rfq_id=f"rfq_{uuid.uuid4().hex[:12]}", tenant_id=tenant, created_at=now)
    expired = make_rfq(
        rfq_id=f"rfq_{uuid.uuid4().hex[:12]}",
        tenant_id=tenant,
        deadline=now - timedelta(minutes=1),
        created_at=now - timedelta(days=1),
    )
    for rfq in (open_rfq, expired):
        await store.create(rfq, events.rfq_created(rfq))

    by_status = {
        status: [r.rfq_id for r in await store.list(tenant, status, now)]
        for status in ("", "open", "expired", "awarded")
    }
    assert by_status == {
        "": [open_rfq.rfq_id, expired.rfq_id],  # newest first
        "open": [open_rfq.rfq_id],
        "expired": [expired.rfq_id],
        "awarded": [],
    }
    assert await store.list(f"{tenant}_other", "", now) == []  # tenant isolation


async def test_bid_submitted_is_applied_once(store, cleanup, tenant):
    rfq = await create_rfq(RfqService(store, FakeBids()), tenant)

    def bid_event(price: str, supplier: str) -> BidSubmitted:
        event_id = str(uuid.uuid4())
        cleanup.event_ids.append(event_id)
        return BidSubmitted(
            event_id=event_id,
            tenant_id=tenant,
            rfq_id=rfq.rfq_id,
            bid_id=f"bid_{uuid.uuid4().hex[:12]}",
            supplier_name=supplier,
            unit_price=Decimal(price),
        )

    kestrel = bid_event("0.39", "Kestrel Fastening Co.")
    assert await store.apply_bid_submitted(kestrel, CONSUMER_NAME) is True
    assert await store.apply_bid_submitted(kestrel, CONSUMER_NAME) is False  # redelivery

    after_one = await store.get(tenant, rfq.rfq_id)
    assert after_one.bid_count == 1
    assert after_one.best_bid_unit_price == Decimal("0.3900")
    assert after_one.best_bid_supplier_name == "Kestrel Fastening Co."

    await store.apply_bid_submitted(bid_event("0.58", "Northgate Fasteners"), CONSUMER_NAME)
    await store.apply_bid_submitted(bid_event("0.35", "Harbor Supply"), CONSUMER_NAME)
    final = await store.get(tenant, rfq.rfq_id)
    assert final.bid_count == 3
    assert (final.best_bid_unit_price, final.best_bid_supplier_name) == (
        Decimal("0.3500"),
        "Harbor Supply",
    )


async def test_bid_for_unknown_rfq_is_permanent_and_leaves_no_trace(pool, store, cleanup, tenant):
    event_id = str(uuid.uuid4())
    cleanup.event_ids.append(event_id)
    bid = BidSubmitted(
        event_id=event_id,
        tenant_id=tenant,
        rfq_id="rfq_000000000000",
        bid_id="bid_x",
        supplier_name="Nobody",
        unit_price=Decimal("1"),
    )
    with pytest.raises(PermanentError):
        await store.apply_bid_submitted(bid, CONSUMER_NAME)
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT count(*) FROM processed_events WHERE event_id = %s", (event_id,)
        )
        assert (await cur.fetchone())[0] == 0  # rolled back with the failed update
