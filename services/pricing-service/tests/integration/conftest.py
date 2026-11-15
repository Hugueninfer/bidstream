"""Fixtures for tests against real Postgres and Redis (see `make test-integration`).

Each test gets a freshly created `pricing_test` database and an empty Redis DB 15,
so nothing touches the service's real `pricing` database.
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator

import psycopg
import pytest
import redis.asyncio as aioredis
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg_pool import AsyncConnectionPool

ADMIN_URL = os.environ.get(
    "TEST_POSTGRES_URL", "postgresql://bidstream:bidstream@localhost:55432/postgres"
)
REDIS_URL = os.environ.get("TEST_REDIS_URL", "redis://localhost:56379/15")
TEST_DB = "pricing_test"


async def _admin(statement: str) -> None:
    async with await psycopg.AsyncConnection.connect(ADMIN_URL, autocommit=True) as conn:
        await conn.execute(sql.SQL(statement).format(sql.Identifier(TEST_DB)))


@pytest.fixture
async def database_url() -> AsyncIterator[str]:
    await _admin("DROP DATABASE IF EXISTS {} WITH (FORCE)")
    await _admin("CREATE DATABASE {}")
    yield make_conninfo(ADMIN_URL, dbname=TEST_DB)
    await _admin("DROP DATABASE IF EXISTS {} WITH (FORCE)")


@pytest.fixture
async def make_pool(database_url):
    """Factory: each call is a new pool, i.e. a simulated service (re)start."""
    pools: list[AsyncConnectionPool] = []

    async def factory() -> AsyncConnectionPool:
        pool = AsyncConnectionPool(database_url, min_size=1, max_size=4, open=False)
        await pool.open(wait=True, timeout=10)
        pools.append(pool)
        return pool

    yield factory
    for pool in pools:
        await pool.close()


@pytest.fixture
async def redis() -> AsyncIterator[aioredis.Redis]:
    client = aioredis.from_url(REDIS_URL)
    await client.flushdb()
    yield client
    await client.flushdb()
    await client.aclose()
