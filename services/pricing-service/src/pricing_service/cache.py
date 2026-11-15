"""Redis estimate cache with per-SKU versioned keys.

    price:ver:{sku}                     INCR-ed counter (missing = 0)
    price:{sku}:v{version}:{quantity}   cached estimate, TTL 10 min

Bumping the version orphans every cached quantity for the SKU at once; the old
keys simply expire.
"""

from __future__ import annotations

import json
from typing import Protocol

from .model import PriceEstimate

ESTIMATE_TTL_SECONDS = 600


class RedisLike(Protocol):
    async def get(self, name: str) -> bytes | str | None: ...
    async def set(self, name: str, value: str, ex: int | None = None) -> object: ...
    async def incr(self, name: str) -> int: ...


def version_key(sku: str) -> str:
    return f"price:ver:{sku}"


def estimate_key(sku: str, version: int, quantity: int) -> str:
    return f"price:{sku}:v{version}:{quantity}"


class PriceCache:
    """Thin typed wrapper; Redis errors propagate so callers decide how to degrade."""

    def __init__(self, redis: RedisLike) -> None:
        self._redis = redis

    async def version(self, sku: str) -> int:
        raw = await self._redis.get(version_key(sku))
        return int(raw) if raw is not None else 0

    async def bump_version(self, sku: str) -> int:
        return await self._redis.incr(version_key(sku))

    async def get_estimate(self, sku: str, version: int, quantity: int) -> PriceEstimate | None:
        raw = await self._redis.get(estimate_key(sku, version, quantity))
        if raw is None:
            return None
        return PriceEstimate(**json.loads(raw))

    async def put_estimate(
        self, sku: str, version: int, quantity: int, estimate: PriceEstimate
    ) -> None:
        payload = json.dumps(
            {
                "estimated_unit_price": estimate.estimated_unit_price,
                "low": estimate.low,
                "high": estimate.high,
                "sample_size": estimate.sample_size,
                "model_version": estimate.model_version,
            }
        )
        await self._redis.set(
            estimate_key(sku, version, quantity), payload, ex=ESTIMATE_TTL_SECONDS
        )
