"""Model v1: per-SKU log-log regression with an empirical prediction band.

    log(unit_price) = a + b * log(quantity)

`b` is the price elasticity to volume (negative = volume discount). The band is
the estimate scaled by the 10th and 90th percentile of the fit's residuals, so
roughly 80% of historical prices fall inside it.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass

MODEL_VERSION = "v1"
PRICE_DECIMALS = 4


class NotEnoughData(ValueError):
    """Raised when there are no observations to fit."""


@dataclass(frozen=True)
class FittedModel:
    a: float
    b: float
    residual_p10: float
    residual_p90: float
    sample_size: int

    def predict(self, quantity: int) -> PriceEstimate:
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        estimate = math.exp(self.a + self.b * math.log(quantity))
        return PriceEstimate(
            estimated_unit_price=round(estimate, PRICE_DECIMALS),
            low=round(estimate * math.exp(self.residual_p10), PRICE_DECIMALS),
            high=round(estimate * math.exp(self.residual_p90), PRICE_DECIMALS),
            sample_size=self.sample_size,
            model_version=MODEL_VERSION,
        )


@dataclass(frozen=True)
class PriceEstimate:
    estimated_unit_price: float
    low: float
    high: float
    sample_size: int
    model_version: str


def fit(observations: Iterable[tuple[float, float]]) -> FittedModel:
    """Ordinary least squares on (log quantity, log price) pairs.

    `observations` are (quantity, unit_price) pairs; non-positive values are skipped
    because their logarithm is undefined.
    """
    xs: list[float] = []
    ys: list[float] = []
    for quantity, price in observations:
        if quantity > 0 and price > 0:
            xs.append(math.log(quantity))
            ys.append(math.log(price))
    n = len(xs)
    if n == 0:
        raise NotEnoughData("no usable observations")

    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    sxx = sum((x - mean_x) ** 2 for x in xs)
    sxy = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys, strict=True))
    # With a single distinct quantity the slope is undefined: fall back to a flat price.
    b = sxy / sxx if sxx > 0 else 0.0
    a = mean_y - b * mean_x

    residuals = sorted(y - (a + b * x) for x, y in zip(xs, ys, strict=True))
    return FittedModel(
        a=a,
        b=b,
        residual_p10=quantile(residuals, 0.10),
        residual_p90=quantile(residuals, 0.90),
        sample_size=n,
    )


def quantile(sorted_values: list[float], p: float) -> float:
    """Linear-interpolated quantile of an already sorted list (numpy's default method)."""
    if not sorted_values:
        raise ValueError("quantile of empty list")
    position = p * (len(sorted_values) - 1)
    lower = math.floor(position)
    upper = min(lower + 1, len(sorted_values) - 1)
    weight = position - lower
    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight
