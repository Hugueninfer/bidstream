import math
import random

import pytest

from pricing_service import model


def test_fit_recovers_known_parameters_on_noiseless_data():
    a, b = math.log(2.5), -0.08
    observations = [(q, math.exp(a + b * math.log(q))) for q in (10, 50, 200, 1_000, 40_000)]

    fitted = model.fit(observations)

    assert fitted.a == pytest.approx(a, abs=1e-9)
    assert fitted.b == pytest.approx(b, abs=1e-9)
    assert fitted.sample_size == 5
    estimate = fitted.predict(500)
    assert estimate.estimated_unit_price == round(math.exp(a + b * math.log(500)), 4)
    assert estimate.low == estimate.estimated_unit_price == estimate.high


def test_band_brackets_the_estimate_on_noisy_data():
    rng = random.Random(7)
    observations = [
        (q, 3.0 * q**-0.1 * math.exp(rng.gauss(0, 0.1)))
        for q in (rng.randint(100, 10_000) for _ in range(500))
    ]

    estimate = model.fit(observations).predict(1_000)

    assert estimate.low < estimate.estimated_unit_price < estimate.high
    assert estimate.model_version == "v1"


def test_band_covers_about_80_percent_of_history():
    rng = random.Random(11)
    observations = [(q, 5.0 * q**-0.05 * math.exp(rng.gauss(0, 0.2))) for q in range(1, 2_001)]
    fitted = model.fit(observations)

    inside = 0
    for q, price in observations:
        center = math.exp(fitted.a + fitted.b * math.log(q))
        if (
            center * math.exp(fitted.residual_p10)
            <= price
            <= center * math.exp(fitted.residual_p90)
        ):
            inside += 1
    assert inside / len(observations) == pytest.approx(0.8, abs=0.01)


def test_single_quantity_falls_back_to_a_flat_price():
    fitted = model.fit([(100, 2.0), (100, 2.0)])
    assert fitted.b == 0.0
    assert fitted.predict(1_000_000).estimated_unit_price == 2.0


def test_non_positive_observations_are_skipped():
    assert model.fit([(0, 1.0), (10, -1.0), (10, 1.0)]).sample_size == 1


def test_fit_without_data_raises():
    with pytest.raises(model.NotEnoughData):
        model.fit([])


def test_predict_rejects_non_positive_quantity():
    with pytest.raises(ValueError):
        model.fit([(10, 1.0)]).predict(0)


@pytest.mark.parametrize(
    ("p", "expected"), [(0.0, 1.0), (0.1, 1.4), (0.5, 3.0), (0.9, 4.6), (1.0, 5.0)]
)
def test_quantile_interpolates_linearly(p, expected):
    assert model.quantile([1.0, 2.0, 3.0, 4.0, 5.0], p) == pytest.approx(expected)


def test_v2_weights_recent_observations_more():
    # Prices fell from 2.0 two years ago to 1.0 this month, at the same quantity.
    history = [(100, 2.0, 730.0)] * 50 + [(100, 1.0, 10.0)] * 50
    v1 = model.fit(history, "v1").predict(100)
    v2 = model.fit(history, "v2").predict(100)
    assert v1.model_version == "v1" and v2.model_version == "v2"
    assert v1.estimated_unit_price == pytest.approx(math.sqrt(2.0), rel=1e-3)
    assert v2.estimated_unit_price < v1.estimated_unit_price


def test_v2_matches_v1_when_all_observations_have_the_same_age():
    history = [(q, 5.0 * q**-0.1, 30.0) for q in (10, 100, 1_000, 10_000)]
    v1 = model.fit(history, "v1")
    v2 = model.fit(history, "v2")
    assert v2.a == pytest.approx(v1.a) and v2.b == pytest.approx(v1.b)


def test_unknown_model_version_is_rejected():
    with pytest.raises(ValueError):
        model.fit([(10, 1.0)], "v9")
