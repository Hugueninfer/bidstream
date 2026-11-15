"""Deterministic synthetic price history for the demo catalog.

Each observation follows the same shape model v1 fits, plus log-normal noise:

    price = anchor * (q / typical) ** VOLUME_ELASTICITY * exp(N(0, NOISE_SIGMA))

with q log-uniform in [0.1x, 3x] the typical quantity, so the fitted band at the
typical quantity lands near anchor * exp(+-1.2816 * sigma) ~= +-11%.
"""

from __future__ import annotations

import math
import random
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import datetime, timedelta

from .catalog import CATALOG, CatalogSku

SEED = 42
VOLUME_ELASTICITY = -0.08
NOISE_SIGMA = 0.082  # ln(1.11) / z(0.90) -> 80% band of about +-11%
HISTORY = timedelta(days=730)
QUANTITY_RANGE = (0.1, 3.0)  # multiples of the typical quantity


@dataclass(frozen=True)
class SeedObservation:
    sku: str
    quantity: int
    unit_price: float
    observed_at: datetime


def generate(now: datetime, catalog: tuple[CatalogSku, ...] = CATALOG) -> Iterator[SeedObservation]:
    """Yield the seed history. Same `now` -> identical output."""
    rng = random.Random(SEED)
    log_lo, log_hi = (math.log(m) for m in QUANTITY_RANGE)
    history_seconds = HISTORY.total_seconds()
    for item in catalog:
        for _ in range(item.seed_rows):
            quantity = max(1, round(item.typical_quantity * math.exp(rng.uniform(log_lo, log_hi))))
            price = (
                item.anchor_price
                * (quantity / item.typical_quantity) ** VOLUME_ELASTICITY
                * math.exp(rng.gauss(0.0, NOISE_SIGMA))
            )
            age = timedelta(seconds=rng.uniform(0.0, history_seconds))
            yield SeedObservation(item.sku, quantity, round(price, 4), now - age)
