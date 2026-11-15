import asyncio


async def sleep_or_stop(stop: asyncio.Event, seconds: float) -> None:
    """Sleep for `seconds`, waking early if `stop` is set."""
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except TimeoutError:
        pass
