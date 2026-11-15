import json
import math

import pytest

from fakes import DownRedis, FakeObservations, FakeRedis
from pricing_service.cache import ESTIMATE_TTL_SECONDS, PriceCache, estimate_key, version_key
from pricing_service.estimator import MODEL_MAX_AGE_SECONDS, Estimator, SkuNotFound

HISTORY = {"BOLT-M8": [(q, 0.47 * (q / 40_000) ** -0.08) for q in (4_000, 20_000, 40_000, 120_000)]}


class Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def redis() -> FakeRedis:
    return FakeRedis()


@pytest.fixture
def observations() -> FakeObservations:
    return FakeObservations({sku: list(rows) for sku, rows in HISTORY.items()})


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def estimator(redis, observations, clock) -> Estimator:
    return Estimator(observations, PriceCache(redis), clock=clock)


def test_key_format():
    assert version_key("BOLT-M8") == "price:ver:BOLT-M8"
    assert estimate_key("BOLT-M8", 3, 40_000) == "price:BOLT-M8:v1:v3:40000"
    assert estimate_key("BOLT-M8", 3, 40_000, "v2") == "price:BOLT-M8:v2:v3:40000"


async def test_missing_version_counts_as_zero(redis):
    assert await PriceCache(redis).version("BOLT-M8") == 0


async def test_miss_then_hit(estimator, redis, observations):
    first = await estimator.estimate("BOLT-M8", 40_000)
    second = await estimator.estimate("BOLT-M8", 40_000)

    assert first.cache_hit is False
    assert second.cache_hit is True
    assert second.estimate == first.estimate
    assert first.estimate.estimated_unit_price == pytest.approx(0.47, abs=1e-4)
    assert observations.loads == 1
    key = "price:BOLT-M8:v1:v0:40000"
    assert (
        json.loads(redis.data[key])["estimated_unit_price"] == first.estimate.estimated_unit_price
    )
    assert redis.ttls[key] == ESTIMATE_TTL_SECONDS


async def test_model_is_reused_across_quantities(estimator, observations):
    await estimator.estimate("BOLT-M8", 1_000)
    await estimator.estimate("BOLT-M8", 2_000)
    assert observations.loads == 1


async def test_version_bump_invalidates_cache_and_model(estimator, redis, observations):
    await estimator.estimate("BOLT-M8", 40_000)
    await PriceCache(redis).bump_version("BOLT-M8")
    observations.by_sku["BOLT-M8"].append((40_000, 0.60))

    result = await estimator.estimate("BOLT-M8", 40_000)

    assert result.cache_hit is False
    assert result.estimate.sample_size == 5
    assert observations.loads == 2
    assert "price:BOLT-M8:v1:v1:40000" in redis.data


async def test_model_expires_even_without_a_version_bump(estimator, observations, clock):
    await estimator.estimate("BOLT-M8", 1_000)
    clock.now += MODEL_MAX_AGE_SECONDS + 1
    await estimator.estimate("BOLT-M8", 2_000)
    assert observations.loads == 2


async def test_unknown_sku_is_not_found_and_not_cached(estimator, redis):
    with pytest.raises(SkuNotFound):
        await estimator.estimate("NOPE", 10)
    assert not any(key.startswith("price:NOPE:") for key in redis.data)


async def test_redis_down_degrades_to_uncached(observations):
    estimator = Estimator(observations, PriceCache(DownRedis()))

    first = await estimator.estimate("BOLT-M8", 40_000)
    second = await estimator.estimate("BOLT-M8", 40_000)

    assert first.cache_hit is second.cache_hit is False
    assert second.estimate.estimated_unit_price == pytest.approx(0.47, abs=1e-4)
    # Without a version we can't tell whether the model is current, so refit.
    assert observations.loads == 2


async def test_corrupt_cache_entry_is_recomputed(estimator, redis):
    redis.data["price:BOLT-M8:v1:v0:40000"] = "{not json"
    result = await estimator.estimate("BOLT-M8", 40_000)
    assert result.cache_hit is False
    assert math.isclose(
        json.loads(redis.data["price:BOLT-M8:v1:v0:40000"])["low"], result.estimate.low
    )
