import re
from datetime import UTC, datetime, timedelta

import pytest

from rfq_service.domain import (
    effective_status,
    format_ts,
    new_rfq_id,
    parse_rfc3339,
    validate_list_status,
    validate_new_rfq,
)
from rfq_service.errors import InvalidArgument
from tests.fakes import NOW

VALID = {
    "tenant_id": "tenant_demo",
    "title": "M8 bolts for Q1",
    "sku": "BOLT-M8",
    "quantity": 40_000,
    "unit": "pcs",
    "deadline": "2026-11-16T17:00:00Z",
}


def validate(**overrides: object):
    return validate_new_rfq(**{**VALID, **overrides}, now=NOW)  # type: ignore[arg-type]


class TestValidateNewRfq:
    def test_valid_input_builds_an_open_rfq(self):
        rfq = validate(title="  M8 bolts  ")
        assert rfq.status == "open"
        assert rfq.title == "M8 bolts"
        assert rfq.deadline == datetime(2026, 11, 16, 17, tzinfo=UTC)
        assert rfq.created_at == NOW
        assert rfq.bid_count == 0

    def test_deadline_with_offset_is_normalised_to_utc(self):
        rfq = validate(deadline="2026-11-16T14:00:00-03:00")
        assert rfq.deadline == datetime(2026, 11, 16, 17, tzinfo=UTC)
        assert rfq.deadline.utcoffset() == timedelta(0)

    @pytest.mark.parametrize("title", ["ab", "   ab   ", "x" * 201, ""])
    def test_title_length(self, title):
        with pytest.raises(InvalidArgument, match="title must be 3-200 characters"):
            validate(title=title)

    @pytest.mark.parametrize("title", ["abc", "x" * 200])
    def test_title_bounds_are_inclusive(self, title):
        assert validate(title=title).title == title

    @pytest.mark.parametrize("quantity", [0, -5])
    def test_quantity_must_be_positive(self, quantity):
        with pytest.raises(InvalidArgument, match="quantity must be greater than 0"):
            validate(quantity=quantity)

    @pytest.mark.parametrize("field", ["sku", "unit", "tenant_id"])
    def test_required_text_fields(self, field):
        with pytest.raises(InvalidArgument, match=f"{field} must not be empty"):
            validate(**{field: "  "})

    @pytest.mark.parametrize(
        "deadline",
        [
            "",
            "tomorrow",
            "2026-11-16",  # date only
            "2026-11-16T17:00:00",  # no offset
            "2026-13-16T17:00:00Z",  # impossible month
            "16/11/2026 17:00",
        ],
    )
    def test_deadline_must_be_rfc3339(self, deadline):
        with pytest.raises(InvalidArgument, match="deadline must be an RFC 3339 timestamp"):
            validate(deadline=deadline)

    @pytest.mark.parametrize("deadline", ["2026-11-14T12:00:00Z", "2020-01-01T00:00:00Z"])
    def test_deadline_must_be_in_the_future(self, deadline):
        with pytest.raises(InvalidArgument, match="deadline must be in the future"):
            validate(deadline=deadline)

    def test_reports_every_problem_at_once(self):
        with pytest.raises(InvalidArgument) as exc:
            validate(title="x", quantity=0, sku="")
        message = str(exc.value)
        assert "title" in message and "quantity" in message and "sku" in message


class TestParseRfc3339:
    @pytest.mark.parametrize(
        "value",
        [
            "2026-11-16T17:00:00Z",
            "2026-11-16t17:00:00z",
            "2026-11-16T17:00:00.123456Z",
            "2026-11-16T17:00:00+00:00",
            "2026-11-16 17:00:00+02:00",
        ],
    )
    def test_accepts(self, value):
        assert parse_rfc3339(value) is not None

    def test_keeps_the_offset(self):
        assert parse_rfc3339("2026-11-16T19:00:00+02:00") == datetime(2026, 11, 16, 17, tzinfo=UTC)


def test_format_ts_is_utc_second_precision_with_z_suffix():
    assert (
        format_ts(datetime(2026, 11, 16, 17, 0, 0, 999_999, tzinfo=UTC)) == "2026-11-16T17:00:00Z"
    )
    assert format_ts(parse_rfc3339("2026-11-16T19:00:00+02:00")) == "2026-11-16T17:00:00Z"


class TestEffectiveStatus:
    def test_open_before_deadline(self):
        assert effective_status("open", NOW + timedelta(seconds=1), NOW) == "open"

    def test_open_at_exact_deadline_is_still_open(self):
        assert effective_status("open", NOW, NOW) == "open"

    def test_open_past_deadline_is_expired(self):
        assert effective_status("open", NOW - timedelta(seconds=1), NOW) == "expired"

    def test_awarded_stays_awarded_after_deadline(self):
        assert effective_status("awarded", NOW - timedelta(days=1), NOW) == "awarded"


@pytest.mark.parametrize("status", ["", "open", "awarded", "expired"])
def test_list_status_filter_accepts_known_values(status):
    assert validate_list_status(status) == status


def test_list_status_filter_rejects_unknown_values():
    with pytest.raises(InvalidArgument):
        validate_list_status("closed")


def test_rfq_id_format():
    ids = {new_rfq_id() for _ in range(1000)}
    assert len(ids) == 1000
    assert all(re.fullmatch(r"rfq_[0-9a-f]{12}", rfq_id) for rfq_id in ids)
