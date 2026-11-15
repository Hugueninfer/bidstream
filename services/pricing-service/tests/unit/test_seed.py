from collections import Counter
from datetime import UTC, datetime, timedelta

import pytest

from pricing_service import model, seed
from pricing_service.catalog import CATALOG

NOW = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def history() -> list[seed.SeedObservation]:
    return list(seed.generate(NOW))


def _fit(history, sku):
    return model.fit((o.quantity, o.unit_price) for o in history if o.sku == sku)


def test_generator_is_deterministic(history):
    assert list(seed.generate(NOW)) == history


def test_row_counts_per_sku(history):
    counts = Counter(o.sku for o in history)
    assert counts["BOLT-M8"] == 1_284
    assert set(counts) == {item.sku for item in CATALOG}
    assert all(900 <= n <= 1_300 for n in counts.values())


def test_quantities_and_dates_stay_in_range(history):
    typical = {item.sku: item.typical_quantity for item in CATALOG}
    for o in history:
        assert 0.1 * typical[o.sku] - 1 <= o.quantity <= 3 * typical[o.sku] + 1
        assert NOW - timedelta(days=730) <= o.observed_at <= NOW
        assert o.unit_price > 0


def test_bolt_m8_estimate_matches_the_ui_design(history):
    estimate = _fit(history, "BOLT-M8").predict(40_000)

    assert 0.45 <= estimate.estimated_unit_price <= 0.49
    assert 0.41 <= estimate.low <= 0.44
    assert 0.50 <= estimate.high <= 0.54
    assert estimate.sample_size == 1_284


@pytest.mark.parametrize("item", CATALOG, ids=lambda item: item.sku)
def test_every_sku_estimates_near_its_anchor(history, item):
    fitted = _fit(history, item.sku)
    estimate = fitted.predict(item.typical_quantity)

    assert estimate.estimated_unit_price == pytest.approx(item.anchor_price, rel=0.04)
    assert fitted.b == pytest.approx(seed.VOLUME_ELASTICITY, abs=0.02)
    # 80% band of roughly +-11%
    assert estimate.high / estimate.estimated_unit_price == pytest.approx(1.11, abs=0.03)
    assert estimate.low / estimate.estimated_unit_price == pytest.approx(0.90, abs=0.03)
