"""GetPriceEstimate logic: Redis cache -> in-process model cache -> fit from Postgres."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Protocol

from redis.exceptions import RedisError

from . import model
from .cache import PriceCache
from .model import FittedModel, PriceEstimate

log = logging.getLogger(__name__)

# Upper bound on how long a fitted model is reused if a version bump is lost
# (e.g. Redis was down when an award arrived). Matches the Redis estimate TTL.
MODEL_MAX_AGE_SECONDS = 600


class SkuNotFound(LookupError):
    pass


class ObservationSource(Protocol):
    async def load_observations(self, sku: str) -> list[tuple[float, ...]]: ...


@dataclass(frozen=True)
class EstimateResult:
    estimate: PriceEstimate
    cache_hit: bool


@dataclass
class _CachedModel:
    version: int
    model: FittedModel
    fitted_at: float


class Estimator:
    def __init__(
        self,
        observations: ObservationSource,
        cache: PriceCache,
        clock=time.monotonic,
        model_version: str = "v1",
    ) -> None:
        self._observations = observations
        self._model_version = model_version
        self._cache = cache
        self._clock = clock
        # One entry per SKU: only the current version is ever useful.
        self._models: dict[str, _CachedModel] = {}
        self._fit_locks: dict[str, asyncio.Lock] = {}

    async def estimate(self, sku: str, quantity: int) -> EstimateResult:
        version = await self._cache_version(sku)
        if version is not None:
            cached = await self._cache_get(sku, version, quantity)
            if cached is not None:
                return EstimateResult(cached, cache_hit=True)

        fitted = await self._model_for(sku, version)
        estimate = fitted.predict(quantity)
        if version is not None:
            await self._cache_put(sku, version, quantity, estimate)
        return EstimateResult(estimate, cache_hit=False)

    async def _model_for(self, sku: str, version: int | None) -> FittedModel:
        """Fitted model for (sku, version). With no version (Redis down) always refit."""
        if version is not None and (hit := self._fresh_model(sku, version)) is not None:
            return hit
        # Single-flight: concurrent misses for one SKU wait for a single fit.
        lock = self._fit_locks.setdefault(sku, asyncio.Lock())
        async with lock:
            if version is not None and (hit := self._fresh_model(sku, version)) is not None:
                return hit
            observations = await self._observations.load_observations(sku)
            try:
                fitted = model.fit(observations, self._model_version)
            except model.NotEnoughData:
                raise SkuNotFound(sku) from None
            if version is not None:
                self._models[sku] = _CachedModel(version, fitted, self._clock())
            log.info(
                "model fitted",
                extra={
                    "sku": sku,
                    "version": version,
                    "model_version": self._model_version,
                    "sample_size": fitted.sample_size,
                    "a": round(fitted.a, 6),
                    "b": round(fitted.b, 6),
                },
            )
            return fitted

    def _fresh_model(self, sku: str, version: int) -> FittedModel | None:
        entry = self._models.get(sku)
        if entry is None or entry.version != version:
            return None
        if self._clock() - entry.fitted_at > MODEL_MAX_AGE_SECONDS:
            return None
        return entry.model

    # Redis is an optimisation: every failure degrades to "no cache", never to an error.

    async def _cache_version(self, sku: str) -> int | None:
        try:
            return await self._cache.version(sku)
        except (RedisError, OSError) as exc:
            log.warning(
                "redis unavailable; serving uncached", extra={"sku": sku, "error": str(exc)}
            )
            return None

    async def _cache_get(self, sku: str, version: int, quantity: int) -> PriceEstimate | None:
        try:
            return await self._cache.get_estimate(sku, version, quantity)
        except (RedisError, OSError) as exc:
            log.warning("redis read failed", extra={"sku": sku, "error": str(exc)})
        except (ValueError, TypeError) as exc:
            log.warning("ignoring corrupt cache entry", extra={"sku": sku, "error": str(exc)})
        return None

    async def _cache_put(
        self, sku: str, version: int, quantity: int, estimate: PriceEstimate
    ) -> None:
        try:
            await self._cache.put_estimate(sku, version, quantity, estimate)
        except (RedisError, OSError) as exc:
            log.warning("redis write failed", extra={"sku": sku, "error": str(exc)})
