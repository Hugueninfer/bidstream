"""Postgres persistence for RFQs, the outbox and processed events."""

from dataclasses import fields
from datetime import datetime

from psycopg import AsyncConnection, sql
from psycopg.rows import class_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from .bid_events import BidSubmitted, PermanentError
from .domain import BidInfo, RfqRecord
from .events import OutboxEvent

# Maximum rows ListRfqs returns; the proto has no pagination yet.
LIST_LIMIT = 1000

# Explicit column list (not `*`) so adding a column never breaks class_row(RfqRecord).
_RFQ_COLUMNS = sql.SQL(", ").join(sql.Identifier(f.name) for f in fields(RfqRecord))

_STATUS_FILTERS = {
    "": "",
    "open": "AND status = 'open' AND deadline >= %(now)s",
    "expired": "AND status = 'open' AND deadline < %(now)s",
    "awarded": "AND status = 'awarded'",
}


class PgRfqStore:
    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool

    async def create(self, rfq: RfqRecord, event: OutboxEvent) -> None:
        async with self._pool.connection() as conn, conn.transaction():
            await conn.execute(
                """INSERT INTO rfqs (rfq_id, tenant_id, title, sku, quantity, unit,
                                     deadline, status, created_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    rfq.rfq_id,
                    rfq.tenant_id,
                    rfq.title,
                    rfq.sku,
                    rfq.quantity,
                    rfq.unit,
                    rfq.deadline,
                    rfq.status,
                    rfq.created_at,
                ),
            )
            await _insert_outbox(conn, event)

    async def get(self, tenant_id: str, rfq_id: str) -> RfqRecord | None:
        async with self._pool.connection() as conn:
            cur = conn.cursor(row_factory=class_row(RfqRecord))
            await cur.execute(
                sql.SQL("SELECT {} FROM rfqs WHERE tenant_id = %s AND rfq_id = %s").format(
                    _RFQ_COLUMNS
                ),
                (tenant_id, rfq_id),
            )
            return await cur.fetchone()

    async def list(self, tenant_id: str, status: str, now: datetime) -> list[RfqRecord]:
        query = sql.SQL(
            """SELECT {columns} FROM rfqs
               WHERE tenant_id = %(tenant_id)s {status_filter}
               ORDER BY created_at DESC, rfq_id DESC
               LIMIT %(limit)s"""
        ).format(columns=_RFQ_COLUMNS, status_filter=sql.SQL(_STATUS_FILTERS[status]))
        async with self._pool.connection() as conn:
            cur = conn.cursor(row_factory=class_row(RfqRecord))
            await cur.execute(query, {"tenant_id": tenant_id, "now": now, "limit": LIST_LIMIT})
            return await cur.fetchall()

    async def mark_awarded(
        self, rfq: RfqRecord, bid: BidInfo, awarded_at: datetime, event: OutboxEvent
    ) -> RfqRecord | None:
        async with self._pool.connection() as conn, conn.transaction():
            cur = conn.cursor(row_factory=class_row(RfqRecord))
            # The status guard makes concurrent awards race-safe: only one UPDATE matches.
            await cur.execute(
                sql.SQL(
                    """UPDATE rfqs
                       SET status = 'awarded', awarded_bid_id = %s, awarded_supplier_name = %s,
                           awarded_unit_price = %s, awarded_at = %s
                       WHERE tenant_id = %s AND rfq_id = %s AND status = 'open'
                       RETURNING {}"""
                ).format(_RFQ_COLUMNS),
                (
                    bid.bid_id,
                    bid.supplier_name,
                    bid.unit_price,
                    awarded_at,
                    rfq.tenant_id,
                    rfq.rfq_id,
                ),
            )
            awarded = await cur.fetchone()
            if awarded is not None:
                await _insert_outbox(conn, event)
            return awarded

    async def apply_bid_submitted(self, bid: BidSubmitted, consumer: str) -> bool:
        """Count the bid and keep the lowest price. False if the event was already applied."""
        async with self._pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                """INSERT INTO processed_events (event_id, consumer) VALUES (%s, %s)
                   ON CONFLICT DO NOTHING""",
                (bid.event_id, consumer),
            )
            if cur.rowcount == 0:
                return False
            # SET expressions all read the pre-update row, so their order doesn't matter.
            cur = await conn.execute(
                """UPDATE rfqs SET
                     bid_count = bid_count + 1,
                     best_bid_supplier_name = CASE
                       WHEN best_bid_unit_price IS NULL OR %(price)s < best_bid_unit_price
                       THEN %(supplier)s ELSE best_bid_supplier_name END,
                     best_bid_unit_price = CASE
                       WHEN best_bid_unit_price IS NULL OR %(price)s < best_bid_unit_price
                       THEN %(price)s ELSE best_bid_unit_price END
                   WHERE tenant_id = %(tenant_id)s AND rfq_id = %(rfq_id)s""",
                {
                    "price": bid.unit_price,
                    "supplier": bid.supplier_name,
                    "tenant_id": bid.tenant_id,
                    "rfq_id": bid.rfq_id,
                },
            )
            if cur.rowcount == 0:
                # Rolls back the processed_events row too; the message goes to the DLQ.
                raise PermanentError(f"bid for unknown rfq {bid.rfq_id} (tenant {bid.tenant_id})")
            return True


async def _insert_outbox(conn: AsyncConnection, event: OutboxEvent) -> None:
    await conn.execute(
        """INSERT INTO outbox (event_id, topic, key, payload, headers)
           VALUES (%s, %s, %s, %s, %s)""",
        (event.event_id, event.topic, event.key, Jsonb(event.payload), Jsonb(event.headers)),
    )
