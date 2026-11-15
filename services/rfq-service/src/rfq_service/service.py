"""RFQ use cases, independent of gRPC and Postgres (both are injected)."""

import logging
from collections.abc import Callable
from datetime import datetime
from typing import Protocol

from . import events
from .domain import (
    BidInfo,
    RfqRecord,
    require,
    utcnow,
    validate_list_status,
    validate_new_rfq,
)
from .errors import FailedPrecondition, NotFound
from .events import OutboxEvent
from .tracing import current_traceparent

log = logging.getLogger(__name__)


class RfqStore(Protocol):
    async def create(self, rfq: RfqRecord, event: OutboxEvent) -> None: ...

    async def get(self, tenant_id: str, rfq_id: str) -> RfqRecord | None: ...

    async def list(self, tenant_id: str, status: str, now: datetime) -> list[RfqRecord]: ...

    async def mark_awarded(
        self, rfq: RfqRecord, bid: BidInfo, awarded_at: datetime, event: OutboxEvent
    ) -> RfqRecord | None:
        """Award only if still open; None when the RFQ was no longer open."""
        ...


class BidLookup(Protocol):
    async def get_bid(self, tenant_id: str, bid_id: str) -> BidInfo | None:
        """None when the bid is unknown; raises errors.Unavailable when bid-service is down."""
        ...


class RfqService:
    def __init__(
        self, store: RfqStore, bids: BidLookup, clock: Callable[[], datetime] = utcnow
    ) -> None:
        self._store = store
        self._bids = bids
        self._clock = clock

    def now(self) -> datetime:
        return self._clock()

    async def create(
        self, *, tenant_id: str, title: str, sku: str, quantity: int, unit: str, deadline: str
    ) -> RfqRecord:
        rfq = validate_new_rfq(
            tenant_id=tenant_id,
            title=title,
            sku=sku,
            quantity=quantity,
            unit=unit,
            deadline=deadline,
            now=self._clock(),
        )
        await self._store.create(rfq, events.rfq_created(rfq, current_traceparent()))
        log.info("rfq created", extra={"rfq_id": rfq.rfq_id, "tenant_id": tenant_id})
        return rfq

    async def get(self, *, tenant_id: str, rfq_id: str) -> RfqRecord:
        require(tenant_id=tenant_id, rfq_id=rfq_id)
        rfq = await self._store.get(tenant_id, rfq_id)
        if rfq is None:
            raise NotFound(f"rfq {rfq_id} not found")
        return rfq

    async def list(
        self, *, tenant_id: str, status: str, now: datetime | None = None
    ) -> list[RfqRecord]:
        """`status` filters on the effective status as of `now` (default: the clock)."""
        require(tenant_id=tenant_id)
        status = validate_list_status(status)
        return await self._store.list(tenant_id, status, now or self._clock())

    async def award(self, *, tenant_id: str, rfq_id: str, bid_id: str) -> RfqRecord:
        require(tenant_id=tenant_id, rfq_id=rfq_id, bid_id=bid_id)
        rfq = await self.get(tenant_id=tenant_id, rfq_id=rfq_id)
        # Retries of a successful award short-circuit here, even if bid-service is down.
        if _already_awarded_to(rfq, bid_id):
            return rfq

        bid = await self._bids.get_bid(tenant_id, bid_id)
        if bid is None:
            raise NotFound(f"bid {bid_id} not found")
        if bid.rfq_id != rfq.rfq_id:
            raise FailedPrecondition(f"bid {bid_id} belongs to rfq {bid.rfq_id}, not {rfq_id}")

        # Awarding after the deadline is allowed: buyers award once bidding has closed.
        awarded_at = self._clock()
        event = events.rfq_awarded(rfq, bid, awarded_at, current_traceparent())
        awarded = await self._store.mark_awarded(rfq, bid, awarded_at, event)
        if awarded is not None:
            log.info(
                "rfq awarded",
                extra={"rfq_id": rfq_id, "bid_id": bid_id, "tenant_id": tenant_id},
            )
            return awarded

        # Lost a race with a concurrent award; decide against the winner's state.
        current = await self.get(tenant_id=tenant_id, rfq_id=rfq_id)
        if _already_awarded_to(current, bid_id):
            return current
        raise FailedPrecondition(f"rfq {rfq_id} is not open")


def _already_awarded_to(rfq: RfqRecord, bid_id: str) -> bool:
    """True if `rfq` is awarded to `bid_id`; FailedPrecondition if awarded to another bid."""
    if rfq.status != "awarded":
        return False
    if rfq.awarded_bid_id == bid_id:
        return True
    raise FailedPrecondition(f"rfq {rfq.rfq_id} is already awarded to bid {rfq.awarded_bid_id}")
