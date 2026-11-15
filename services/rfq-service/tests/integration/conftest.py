import os
import uuid

import pytest

from rfq_service.db import create_pool
from rfq_service.migrations import apply_migrations
from rfq_service.store import PgRfqStore


@pytest.fixture
async def pool():
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL is not set")
    pool = create_pool(url, max_size=4)
    await pool.open(wait=True, timeout=10)
    await apply_migrations(pool)
    yield pool
    await pool.close()


class Cleanup:
    """A tenant unique to one test, plus the consumed event ids it must forget."""

    def __init__(self) -> None:
        self.tenant_id = f"it_{uuid.uuid4().hex[:12]}"
        self.event_ids: list[str] = []


@pytest.fixture
async def cleanup(pool):
    cleanup = Cleanup()
    yield cleanup
    async with pool.connection() as conn, conn.transaction():
        await conn.execute(
            "DELETE FROM outbox WHERE payload->>'tenant_id' = %s", (cleanup.tenant_id,)
        )
        await conn.execute(
            "DELETE FROM processed_events WHERE event_id = ANY(%s::uuid[])", (cleanup.event_ids,)
        )
        await conn.execute("DELETE FROM rfqs WHERE tenant_id = %s", (cleanup.tenant_id,))


@pytest.fixture
def tenant(cleanup):
    return cleanup.tenant_id


@pytest.fixture
def store(pool):
    return PgRfqStore(pool)
