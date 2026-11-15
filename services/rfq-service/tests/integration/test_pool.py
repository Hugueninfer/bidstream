"""The connection pool must survive callers being cancelled mid-checkout.

gRPC cancels a handler when the client's deadline expires, so under overload many
coroutines are cancelled while waiting for, checking or returning a connection.
psycopg-pool < 3.3 lost connections in that race: the pool kept counting them as
in use, every later request timed out and the service never recovered on its own.
"""

import asyncio
import random

import pytest

pytestmark = pytest.mark.integration

BURSTS = 200
CALLERS_PER_BURST = 40  # ten times the pool size used by the fixture


async def _use_connection(pool) -> None:
    async with pool.connection() as conn:
        await conn.execute("SELECT pg_sleep(%s)", (random.uniform(0.0, 0.05),))


async def test_pool_recovers_after_cancelled_callers(pool):
    for _ in range(BURSTS):
        callers = [asyncio.create_task(_use_connection(pool)) for _ in range(CALLERS_PER_BURST)]
        await asyncio.sleep(random.uniform(0.0, 0.02))
        random.shuffle(callers)
        for caller in callers:
            caller.cancel()
            if random.random() < 0.3:
                await asyncio.sleep(0)  # let some cancellations land mid-checkout
        await asyncio.gather(*callers, return_exceptions=True)

    async with pool.connection(timeout=5) as conn:
        await conn.execute("SELECT 1")
    await asyncio.sleep(0.5)  # returned connections are reset in the background
    stats = pool.get_stats()
    assert stats["pool_available"] == stats["pool_size"], stats
