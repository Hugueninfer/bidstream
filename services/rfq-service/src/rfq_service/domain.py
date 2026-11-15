"""RFQ model and the rules that don't need I/O: validation, status, IDs, timestamps."""

import re
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from .errors import InvalidArgument

TITLE_MIN_LEN = 3
TITLE_MAX_LEN = 200
LIST_STATUS_FILTERS = frozenset({"", "open", "awarded", "expired"})

_RFC3339 = re.compile(r"\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})")


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_rfq_id() -> str:
    return "rfq_" + secrets.token_hex(6)


def format_ts(ts: datetime) -> str:
    """RFC 3339 in UTC with a `Z` suffix, second precision (the wire format)."""
    return ts.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_rfc3339(value: str) -> datetime | None:
    """Strict RFC 3339 (offset required). `datetime.fromisoformat` alone also
    accepts dates without a time and naive timestamps, which we must reject."""
    if not _RFC3339.fullmatch(value):
        return None
    try:
        return datetime.fromisoformat(value.upper())
    except ValueError:  # well-formed but impossible, e.g. month 13
        return None


@dataclass(frozen=True)
class RfqRecord:
    """One row of the `rfqs` table (field names match the columns)."""

    rfq_id: str
    tenant_id: str
    title: str
    sku: str
    quantity: int
    unit: str
    deadline: datetime
    status: str  # stored status: "open" or "awarded"
    created_at: datetime
    bid_count: int = 0
    best_bid_unit_price: Decimal | None = None
    best_bid_supplier_name: str | None = None
    awarded_bid_id: str | None = None
    awarded_supplier_name: str | None = None
    awarded_unit_price: Decimal | None = None
    awarded_at: datetime | None = None

    def effective_status(self, now: datetime) -> str:
        return effective_status(self.status, self.deadline, now)


def effective_status(stored_status: str, deadline: datetime, now: datetime) -> str:
    """`expired` is never stored: it is an open RFQ whose deadline has passed."""
    if stored_status == "open" and deadline < now:
        return "expired"
    return stored_status


@dataclass(frozen=True)
class BidInfo:
    """What rfq-service needs to know about a bid (from bid-service GetBid)."""

    bid_id: str
    tenant_id: str
    rfq_id: str
    supplier_id: str
    supplier_name: str
    unit_price: Decimal


def require(**fields: str) -> None:
    missing = [name for name, value in fields.items() if not value.strip()]
    if missing:
        raise InvalidArgument(f"{', '.join(missing)} must not be empty")


def validate_new_rfq(
    *,
    tenant_id: str,
    title: str,
    sku: str,
    quantity: int,
    unit: str,
    deadline: str,
    now: datetime,
) -> RfqRecord:
    """Return a new open RFQ, or raise InvalidArgument listing every problem."""
    problems: list[str] = []
    title, sku, unit = title.strip(), sku.strip(), unit.strip()

    if not tenant_id.strip():
        problems.append("tenant_id must not be empty")
    if not TITLE_MIN_LEN <= len(title) <= TITLE_MAX_LEN:
        problems.append(f"title must be {TITLE_MIN_LEN}-{TITLE_MAX_LEN} characters")
    if not sku:
        problems.append("sku must not be empty")
    if quantity <= 0:
        problems.append("quantity must be greater than 0")
    if not unit:
        problems.append("unit must not be empty")
    parsed_deadline = parse_rfc3339(deadline)
    if parsed_deadline is None:
        problems.append("deadline must be an RFC 3339 timestamp, e.g. 2026-11-16T17:00:00Z")
    elif parsed_deadline <= now:
        problems.append("deadline must be in the future")

    if problems:
        raise InvalidArgument("; ".join(problems))
    assert parsed_deadline is not None  # a missing deadline was reported above
    return RfqRecord(
        rfq_id=new_rfq_id(),
        tenant_id=tenant_id,
        title=title,
        sku=sku,
        quantity=quantity,
        unit=unit,
        deadline=parsed_deadline.astimezone(UTC),
        status="open",
        created_at=now,
    )


def validate_list_status(status: str) -> str:
    if status not in LIST_STATUS_FILTERS:
        raise InvalidArgument('status must be one of "", "open", "awarded", "expired"')
    return status
