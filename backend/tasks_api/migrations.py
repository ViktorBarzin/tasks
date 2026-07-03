"""Run alembic migrations programmatically (app startup + tests).

Paths are resolved absolutely from this file so the working directory never
matters (uvicorn in the container, pytest from anywhere).
"""

from pathlib import Path

from alembic import command
from alembic.config import Config

BACKEND_DIR = Path(__file__).resolve().parents[1]


def upgrade_to_head() -> None:
    """Apply all pending migrations to the DSN from ``TASKS_DB_DSN``.

    Synchronous (alembic drives the async engine via ``asyncio.run`` in
    ``alembic/env.py``) — callers inside a running event loop must push this
    to a worker thread.
    """
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.set_main_option("script_location", str(BACKEND_DIR / "alembic"))
    command.upgrade(config, "head")
