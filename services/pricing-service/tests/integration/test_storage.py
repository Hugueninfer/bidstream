import asyncio
import json
import uuid

import pytest

from pricing_service import db
from pricing_service.cache import PriceCache
from pricing_service.catalog import CATALOG
from pricing_service.estimator import Estimator
from pricing_service.events import AwardHandler, Outcome

pytestmark = pytest.mark.integration

SEED_ROWS = sum(item.seed_rows for item in CATALOG)


async def count(pool, where="TRUE", params=()) -> int:
    async with pool.connection() as conn:
        cur = await conn.execute(f"SELECT count(*) FROM price_observations WHERE {where}", params)
        return (await cur.fetchone())[0]


async def start(make_pool):
    """What the service does on boot."""
    pool = await make_pool()
    await db.migrate(pool)
    await db.seed_if_empty(pool)
    return pool


async def test_migrations_and_seed_run_once_across_restarts(make_pool):
    # Two replicas booting at the same time, then a restart.
    first, second = await asyncio.gather(start(make_pool), start(make_pool))
    restarted = await start(make_pool)

    assert await count(restarted) == SEED_ROWS
    assert await count(restarted, "sku = %s", ("BOLT-M8",)) == 1_284
    assert await db.migrate(restarted) == []
    async with restarted.connection() as conn:
        cur = await conn.execute("SELECT version FROM schema_migrations")
        assert [row[0] for row in await cur.fetchall()] == ["0001_init"]


async def test_estimate_cache_miss_then_hit(make_pool, redis):
    pool = await start(make_pool)
    estimator = Estimator(db.ObservationRepository(pool), PriceCache(redis))

    miss = await estimator.estimate("BOLT-M8", 40_000)
    hit = await estimator.estimate("BOLT-M8", 40_000)

    assert (miss.cache_hit, hit.cache_hit) == (False, True)
    assert hit.estimate == miss.estimate
    assert 0.45 <= miss.estimate.estimated_unit_price <= 0.49
    assert miss.estimate.sample_size == 1_284
    cached = json.loads(await redis.get("price:BOLT-M8:v0:40000"))
    assert cached["estimated_unit_price"] == miss.estimate.estimated_unit_price
    assert 0 < await redis.ttl("price:BOLT-M8:v0:40000") <= 600


async def test_award_processed_twice_is_applied_once(make_pool, redis):
    pool = await start(make_pool)
    cache = PriceCache(redis)
    handler = AwardHandler(db.ObservationRepository(pool), cache)
    estimator = Estimator(db.ObservationRepository(pool), cache)
    await estimator.estimate("BOLT-M8", 40_000)  # warm the v0 cache

    message = json.dumps(
        {
            "event_id": str(uuid.uuid4()),
            "event_type": "rfq.awarded",
            "version": 1,
            "occurred_at": "2026-11-14T14:02:11Z",
            "tenant_id": "tenant_demo",
            "key": "rfq_7f3a91c2b0de",
            "data": {
                "rfq_id": "rfq_7f3a91c2b0de",
                "tenant_id": "tenant_demo",
                "sku": "BOLT-M8",
                "quantity": 40_000,
                "bid_id": "bid_0123456789ab",
                "supplier_id": "sup_kestrel_fastening_co",
                "supplier_name": "Kestrel Fastening Co.",
                "unit_price": 0.39,
                "awarded_at": "2026-11-14T14:02:11Z",
            },
        }
    ).encode()

    assert await handler.handle(message) is Outcome.APPLIED
    assert await handler.handle(message) is Outcome.DUPLICATE

    assert await count(pool, "source = 'award'") == 1
    assert await count(pool, "sku = %s", ("BOLT-M8",)) == 1_285
    assert await cache.version("BOLT-M8") == 1
    after = await estimator.estimate("BOLT-M8", 40_000)
    assert after.cache_hit is False
    assert after.estimate.sample_size == 1_285
