import asyncio

from .app import run
from .config import Settings
from .logs import setup_logging


def main() -> None:
    settings = Settings.from_env()
    setup_logging(settings.log_level)
    asyncio.run(run(settings))


if __name__ == "__main__":
    main()
