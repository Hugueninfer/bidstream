"""In-memory stand-ins for Redis and the observation store."""

from __future__ import annotations

from redis.exceptions import ConnectionError as RedisConnectionError


class FakeRedis:
    def __init__(self) -> None:
        self.data: dict[str, str] = {}
        self.ttls: dict[str, int | None] = {}

    async def get(self, name: str) -> bytes | None:
        value = self.data.get(name)
        return value.encode() if value is not None else None

    async def set(self, name: str, value: str, ex: int | None = None) -> bool:
        self.data[name] = str(value)
        self.ttls[name] = ex
        return True

    async def incr(self, name: str) -> int:
        value = int(self.data.get(name, "0")) + 1
        self.data[name] = str(value)
        return value


class DownRedis:
    """Every call fails the way redis-py does when the server is unreachable."""

    def __init__(self, fail_times: int | None = None) -> None:
        self.calls = 0
        self._fail_times = fail_times
        self._ok = FakeRedis()

    async def _maybe_fail(self) -> None:
        self.calls += 1
        if self._fail_times is None or self.calls <= self._fail_times:
            raise RedisConnectionError("Connection refused")

    async def get(self, name):
        await self._maybe_fail()
        return await self._ok.get(name)

    async def set(self, name, value, ex=None):
        await self._maybe_fail()
        return await self._ok.set(name, value, ex)

    async def incr(self, name):
        await self._maybe_fail()
        return await self._ok.incr(name)


class FakeObservations:
    def __init__(self, by_sku: dict[str, list[tuple[float, float]]]) -> None:
        self.by_sku = by_sku
        self.loads = 0

    async def load_observations(self, sku: str) -> list[tuple[float, float]]:
        self.loads += 1
        return list(self.by_sku.get(sku, []))


class FakeAwardStore:
    def __init__(self) -> None:
        self.seen: set = set()
        self.awards: list = []

    async def record_award(self, award) -> bool:
        if award.event_id in self.seen:
            return False
        self.seen.add(award.event_id)
        self.awards.append(award)
        return True
