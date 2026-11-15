from types import SimpleNamespace

from pricing_service.consumer import DLQ_TOPIC, EventConsumer
from pricing_service.events import Outcome, PoisonMessage


class ScriptedHandler:
    def __init__(self, *results) -> None:
        self.results = list(results)
        self.calls = 0

    async def handle(self, raw):
        self.calls += 1
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class FakeProducer:
    def __init__(self) -> None:
        self.sent = []

    async def send_and_wait(self, topic, value=None, key=None, headers=None):
        self.sent.append(SimpleNamespace(topic=topic, value=value, key=key, headers=headers))


def message():
    return SimpleNamespace(
        value=b'{"event_type": "rfq.awarded"}',
        key=b"rfq_7f3a91c2b0de",
        headers=[("event_type", b"rfq.awarded")],
        partition=0,
        offset=42,
    )


async def test_transient_failure_is_retried_then_succeeds():
    handler = ScriptedHandler(RuntimeError("db blip"), Outcome.APPLIED)
    producer = FakeProducer()

    await EventConsumer("unused:9092", handler, retry_delays=(0, 0, 0))._process(
        message(), producer
    )

    assert handler.calls == 2
    assert producer.sent == []


async def test_persistent_failure_goes_to_dlq_after_three_retries():
    handler = ScriptedHandler(*[RuntimeError("db down")] * 4)
    producer = FakeProducer()
    original = message()

    await EventConsumer("unused:9092", handler, retry_delays=(0, 0, 0))._process(original, producer)

    assert handler.calls == 4
    [dead] = producer.sent
    assert dead.topic == DLQ_TOPIC
    assert (dead.value, dead.key) == (original.value, original.key)
    headers = dict(dead.headers)
    assert headers["event_type"] == b"rfq.awarded"
    assert headers["dlq_consumer"] == b"pricing-service"
    assert headers["dlq_error"] == b"RuntimeError: db down"


async def test_poison_message_skips_retries():
    handler = ScriptedHandler(PoisonMessage("invalid JSON"))
    producer = FakeProducer()

    await EventConsumer("unused:9092", handler, retry_delays=(0, 0, 0))._process(
        message(), producer
    )

    assert handler.calls == 1
    assert dict(producer.sent[0].headers)["dlq_error"].startswith(b"PoisonMessage")
