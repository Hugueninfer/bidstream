"""Postgres access: schema migrations, first-start seeding and the queries the service needs."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from uuid import UUID

from psycopg_pool import AsyncConnectionPool

from . import seed

log = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
CONSUMER_NAME = "pricing-service"

# Arbitrary but fixed keys for pg_advisory_(xact_)lock, so replicas starting
# together don't race each other.
_MIGRATION_LOCK = 7_301_001
_SEED_LOCK = 7_301_002


async def migrate(pool: AsyncConnectionPool) -> list[str]:
    """Apply pending `migrations/*.sql` in name order; returns the versions applied.

    Everything runs in one transaction under an advisory lock: replicas starting
    together apply each migration once, and a failing migration leaves no trace.
    (Postgres DDL is transactional; a future migration that can't be, such as
    CREATE INDEX CONCURRENTLY, would need its own runner.)
    """
    applied: list[str] = []
    async with pool.connection() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(%s)", (_MIGRATION_LOCK,))
        await conn.execute(
            """CREATE TABLE IF NOT EXISTS schema_migrations (
                 version    TEXT PRIMARY KEY,
                 applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"""
        )
        cur = await conn.execute("SELECT version FROM schema_migrations")
        done = {row[0] for row in await cur.fetchall()}
        for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if path.stem in done:
                continue
            await conn.execute(path.read_text())
            await conn.execute("INSERT INTO schema_migrations (version) VALUES (%s)", (path.stem,))
            applied.append(path.stem)
    for version in applied:
        log.info("migration applied", extra={"version": version})
    return applied


async def seed_if_empty(pool: AsyncConnectionPool, now: datetime | None = None) -> int:
    """Insert the synthetic history unless it is already there; returns rows inserted.

    Check and insert share one transaction under an advisory lock, so concurrent
    starts insert exactly once and a crash mid-seed leaves nothing behind.
    """
    now = now or datetime.now(UTC)
    async with pool.connection() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(%s)", (_SEED_LOCK,))
        cur = await conn.execute(
            "SELECT EXISTS (SELECT 1 FROM price_observations WHERE source = 'seed')"
        )
        if (await cur.fetchone())[0]:
            return 0
        rows = 0
        async with conn.cursor().copy(
            "COPY price_observations (sku, quantity, unit_price, source, observed_at) FROM STDIN"
        ) as copy:
            for obs in seed.generate(now):
                await copy.write_row(
                    (obs.sku, obs.quantity, Decimal(str(obs.unit_price)), "seed", obs.observed_at)
                )
                rows += 1
    log.info("seed inserted", extra={"rows": rows})
    return rows


@dataclass(frozen=True)
class Award:
    event_id: UUID
    sku: str
    quantity: int
    unit_price: Decimal
    awarded_at: datetime


class ObservationRepository:
    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool

    async def load_observations(self, sku: str) -> list[tuple[float, float, float]]:
        """All (quantity, unit_price, age_days) observations for a SKU."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                """SELECT quantity, unit_price,
                          EXTRACT(EPOCH FROM now() - observed_at) / 86400
                   FROM price_observations WHERE sku = %s""",
                (sku,),
            )
            return [(float(q), float(p), float(age)) for q, p, age in await cur.fetchall()]

    async def record_award(self, award: Award) -> bool:
        """Append an award to the history, once per event. False if already processed."""
        async with self._pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                """INSERT INTO processed_events (event_id, consumer) VALUES (%s, %s)
                   ON CONFLICT DO NOTHING""",
                (award.event_id, CONSUMER_NAME),
            )
            if cur.rowcount == 0:
                return False
            await conn.execute(
                """INSERT INTO price_observations (sku, quantity, unit_price, source, observed_at)
                   VALUES (%s, %s, %s, 'award', %s)""",
                (award.sku, award.quantity, award.unit_price, award.awarded_at),
            )
            return True

    async def ping(self) -> None:
        async with self._pool.connection() as conn:
            await conn.execute("SELECT 1")
