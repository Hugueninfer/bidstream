"""Handling of rfq.events messages (only `rfq.awarded` matters to pricing)."""

from __future__ import annotations

import asyncio
import enum
import json
import logging
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Protocol
from uuid import UUID

from redis.exceptions import RedisError

from .cache import PriceCache
from .db import Award

log = logging.getLogger(__name__)

AWARDED = "rfq.awarded"
VERSION_BUMP_DELAYS = (0.2, 1.0, 3.0)


class PoisonMessage(ValueError):
    """The message can never be processed (malformed); retrying is pointless."""


class Outcome(enum.Enum):
    IGNORED = "ignored"
    APPLIED = "applied"
    DUPLICATE = "duplicate"


class AwardStore(Protocol):
    async def record_award(self, award: Award) -> bool: ...


def parse_envelope(raw: bytes | None) -> dict:
    try:
        envelope = json.loads(raw or b"")
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise PoisonMessage(f"invalid JSON: {exc}") from None
    if not isinstance(envelope, dict):
        raise PoisonMessage("envelope is not a JSON object")
    return envelope


def parse_award(envelope: dict) -> Award:
    data = envelope.get("data")
    if not isinstance(data, dict):
        raise PoisonMessage("rfq.awarded without a data object")
    try:
        award = Award(
            event_id=UUID(str(envelope["event_id"])),
            sku=str(data["sku"]).strip(),
            quantity=int(data["quantity"]),
            unit_price=Decimal(str(data["unit_price"])),
            awarded_at=datetime.fromisoformat(str(data["awarded_at"]).replace("Z", "+00:00")),
        )
    except (KeyError, ValueError, TypeError, InvalidOperation) as exc:
        raise PoisonMessage(f"invalid rfq.awarded payload: {exc!r}") from None
    if not award.sku or award.quantity <= 0 or not award.unit_price > 0:
        raise PoisonMessage("rfq.awarded needs a sku, quantity > 0 and unit_price > 0")
    if award.awarded_at.tzinfo is None:
        raise PoisonMessage("awarded_at must carry a timezone")
    return award


class AwardHandler:
    def __init__(self, store: AwardStore, cache: PriceCache, bump_delays=VERSION_BUMP_DELAYS):
        self._store = store
        self._cache = cache
        self._bump_delays = bump_delays

    async def handle(self, raw: bytes | None) -> Outcome:
        envelope = parse_envelope(raw)
        if envelope.get("event_type") != AWARDED:
            return Outcome.IGNORED
        award = parse_award(envelope)
        if not await self._store.record_award(award):
            log.info("duplicate event skipped", extra={"event_id": str(award.event_id)})
            return Outcome.DUPLICATE
        await self._bump_version(award.sku)
        log.info(
            "award recorded",
            extra={
                "event_id": str(award.event_id),
                "sku": award.sku,
                "quantity": award.quantity,
                "unit_price": str(award.unit_price),
            },
        )
        return Outcome.APPLIED

    async def _bump_version(self, sku: str) -> None:
        """Invalidate cached estimates for the SKU.

        Runs after the DB commit, so a failure can't be retried by redelivering the
        event (it would be skipped as a duplicate). Retry here instead; if Redis stays
        down, stale estimates live at most one TTL (Redis keys and in-process models
        both expire after 10 minutes).
        """
        for delay in (*self._bump_delays, None):
            try:
                await self._cache.bump_version(sku)
                return
            except (RedisError, OSError) as exc:
                if delay is None:
                    log.error(
                        "cache version bump failed; estimates may be stale for one TTL",
                        extra={"sku": sku, "error": str(exc)},
                    )
                    return
                await asyncio.sleep(delay)
