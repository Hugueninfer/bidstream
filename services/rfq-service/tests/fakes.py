"""In-memory stand-ins for the store and bid-service, shared by unit and integration tests."""

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from rfq_service.domain import BidInfo, RfqRecord
from rfq_service.errors import Unavailable
from rfq_service.events import OutboxEvent

NOW = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)


class FixedClock:
    def __init__(self, now: datetime = NOW) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now


def make_rfq(**overrides: object) -> RfqRecord:
    fields: dict[str, object] = {
        "rfq_id": "rfq_0123456789ab",
        "tenant_id": "tenant_test",
        "title": "M8 bolts",
        "sku": "BOLT-M8",
        "quantity": 40_000,
        "unit": "pcs",
        "deadline": NOW + timedelta(days=3),
        "status": "open",
        "created_at": NOW - timedelta(hours=1),
    }
    fields.update(overrides)
    return RfqRecord(**fields)  # type: ignore[arg-type]


def make_bid(rfq: RfqRecord, **overrides: object) -> BidInfo:
    fields: dict[str, object] = {
        "bid_id": "bid_aaaaaaaaaaaa",
        "tenant_id": rfq.tenant_id,
        "rfq_id": rfq.rfq_id,
        "supplier_id": "sup_kestrel_fastening_co",
        "supplier_name": "Kestrel Fastening Co.",
        "unit_price": Decimal("0.39"),
    }
    fields.update(overrides)
    return BidInfo(**fields)  # type: ignore[arg-type]


class FakeBids:
    def __init__(self, *bids: BidInfo, unavailable: bool = False) -> None:
        self.bids = {bid.bid_id: bid for bid in bids}
        self.unavailable = unavailable
        self.calls = 0

    async def get_bid(self, tenant_id: str, bid_id: str) -> BidInfo | None:
        self.calls += 1
        if self.unavailable:
            raise Unavailable("bid-service unavailable (UNAVAILABLE)")
        bid = self.bids.get(bid_id)
        return bid if bid is not None and bid.tenant_id == tenant_id else None


class FakeStore:
    def __init__(self, *rfqs: RfqRecord) -> None:
        self.rfqs = {(r.tenant_id, r.rfq_id): r for r in rfqs}
        self.outbox: list[OutboxEvent] = []
        # Simulates another replica awarding between our read and our UPDATE.
        self.award_race_winner: BidInfo | None = None

    async def create(self, rfq: RfqRecord, event: OutboxEvent) -> None:
        self.rfqs[(rfq.tenant_id, rfq.rfq_id)] = rfq
        self.outbox.append(event)

    async def get(self, tenant_id: str, rfq_id: str) -> RfqRecord | None:
        return self.rfqs.get((tenant_id, rfq_id))

    async def list(self, tenant_id: str, status: str, now: datetime) -> list[RfqRecord]:
        rfqs = [r for (t, _), r in self.rfqs.items() if t == tenant_id]
        if status:
            rfqs = [r for r in rfqs if r.effective_status(now) == status]
        return sorted(rfqs, key=lambda r: r.created_at, reverse=True)

    async def mark_awarded(
        self, rfq: RfqRecord, bid: BidInfo, awarded_at: datetime, event: OutboxEvent
    ) -> RfqRecord | None:
        if self.award_race_winner is not None:
            winner, self.award_race_winner = self.award_race_winner, None
            self._award(rfq, winner, awarded_at)
        current = self.rfqs[(rfq.tenant_id, rfq.rfq_id)]
        if current.status != "open":
            return None
        self.outbox.append(event)
        return self._award(current, bid, awarded_at)

    def _award(self, rfq: RfqRecord, bid: BidInfo, awarded_at: datetime) -> RfqRecord:
        awarded = replace(
            rfq,
            status="awarded",
            awarded_bid_id=bid.bid_id,
            awarded_supplier_name=bid.supplier_name,
            awarded_unit_price=bid.unit_price,
            awarded_at=awarded_at,
        )
        self.rfqs[(rfq.tenant_id, rfq.rfq_id)] = awarded
        return awarded
