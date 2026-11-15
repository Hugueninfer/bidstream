"""Ordered plain-SQL migrations from ./migrations, tracked in `schema_migrations`.

Replicas may start at the same time, so the whole run happens under a
Postgres advisory lock; the loser waits and then finds nothing to apply."""

import logging
from pathlib import Path

from psycopg_pool import AsyncConnectionPool

log = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).parent / "migrations"
# Arbitrary constant, unique to rfq-service's migrator within its database.
_LOCK_KEY = 0x7266_7173_6D69_67  # "rfqsmig"


def migration_files() -> list[Path]:
    return sorted(MIGRATIONS_DIR.glob("*.sql"))


async def apply_migrations(pool: AsyncConnectionPool) -> list[str]:
    applied_now: list[str] = []
    async with pool.connection() as conn:
        await conn.execute("SELECT pg_advisory_lock(%s)", (_LOCK_KEY,))
        try:
            await conn.execute(
                """CREATE TABLE IF NOT EXISTS schema_migrations (
                     version    TEXT PRIMARY KEY,
                     applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"""
            )
            cur = await conn.execute("SELECT version FROM schema_migrations")
            done = {row[0] for row in await cur.fetchall()}
            for path in migration_files():
                if path.name in done:
                    continue
                async with conn.transaction():
                    await conn.execute(path.read_text())  # type: ignore[arg-type]
                    await conn.execute(
                        "INSERT INTO schema_migrations (version) VALUES (%s)", (path.name,)
                    )
                applied_now.append(path.name)
                log.info("migration applied", extra={"version": path.name})
        finally:
            await conn.execute("SELECT pg_advisory_unlock(%s)", (_LOCK_KEY,))
    return applied_now
