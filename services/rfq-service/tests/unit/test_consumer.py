import psycopg
import pytest

from rfq_service.bid_events import PermanentError
from rfq_service.consumer import InfrastructureError, dlq_headers, process_with_retry


class Flaky:
    def __init__(self, failures: int, error: Exception | None = None) -> None:
        self.failures = failures
        self.error = error or RuntimeError("boom")
        self.calls = 0

    async def __call__(self) -> None:
        self.calls += 1
        if self.calls <= self.failures:
            raise self.error


class Sleeps:
    def __init__(self) -> None:
        self.delays: list[float] = []

    async def __call__(self, delay: float) -> None:
        self.delays.append(delay)


async def test_success_first_time_does_not_sleep():
    handle, sleep = Flaky(0), Sleeps()
    assert await process_with_retry(handle, sleep=sleep) is None
    assert handle.calls == 1 and sleep.delays == []


async def test_recovers_within_the_retry_budget():
    handle, sleep = Flaky(3), Sleeps()
    assert await process_with_retry(handle, sleep=sleep) is None
    assert handle.calls == 4
    assert sleep.delays == [0.2, 1.0, 3.0]


async def test_gives_up_after_three_retries_and_returns_the_error():
    handle, sleep = Flaky(99), Sleeps()
    error = await process_with_retry(handle, sleep=sleep)
    assert isinstance(error, RuntimeError)
    assert handle.calls == 4


async def test_permanent_errors_skip_retries():
    handle, sleep = Flaky(99, PermanentError("bad json")), Sleeps()
    error = await process_with_retry(handle, sleep=sleep)
    assert isinstance(error, PermanentError)
    assert handle.calls == 1 and sleep.delays == []


async def test_database_outage_is_raised_not_dead_lettered():
    handle = Flaky(99, psycopg.OperationalError("connection refused"))
    with pytest.raises(InfrastructureError):
        await process_with_retry(handle, sleep=Sleeps())


def test_dlq_headers_keep_originals_and_add_error_and_consumer():
    original = [("event_type", b"bid.submitted"), ("traceparent", b"00-abc")]
    headers = dlq_headers(original, ValueError("x" * 1000))
    assert headers[:2] == original
    assert dict(headers)["dlq_consumer"] == b"rfq-service"
    error = dict(headers)["dlq_error"]
    assert error.startswith(b"ValueError: x") and len(error) == 500
