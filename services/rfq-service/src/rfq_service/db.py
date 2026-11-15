from psycopg_pool import AsyncConnectionPool


def create_pool(database_url: str, *, max_size: int = 10) -> AsyncConnectionPool:
    """Autocommit connections: every multi-statement write opens an explicit
    `conn.transaction()`, so transaction boundaries are visible in the code."""
    return AsyncConnectionPool(
        database_url,
        min_size=1,
        max_size=max_size,
        open=False,
        kwargs={"autocommit": True},
        check=AsyncConnectionPool.check_connection,  # drop connections broken by a DB restart
        name="rfq-db",
    )
