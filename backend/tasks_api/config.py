"""Environment-driven settings (no config files — the k8s stack injects env)."""

import os
from dataclasses import dataclass

USERNAME_HEADER = "X-Authentik-Username"
DEFAULT_DB_DSN = "sqlite+aiosqlite:///./tasks.db"


@dataclass(frozen=True)
class Settings:
    """Runtime configuration, read from the environment.

    - ``db_dsn``: ``TASKS_DB_DSN`` — Postgres (asyncpg) in production, with a
      sqlite+aiosqlite fallback for dev/tests.
    - ``fernet_key``: ``TASKS_FERNET_KEY`` — encrypts Connected Account app
      passwords (ADR-0002); the key never lives in the DB.
    - ``dev_user``: ``DEV_USER`` — dev-only identity fallback when Authentik's
      forward-auth header is absent.
    """

    db_dsn: str = DEFAULT_DB_DSN
    fernet_key: str | None = None
    dev_user: str | None = None


def get_settings() -> Settings:
    """Read settings fresh from the environment (cheap; also keeps tests simple)."""
    return Settings(
        db_dsn=os.environ.get("TASKS_DB_DSN", DEFAULT_DB_DSN),
        fernet_key=os.environ.get("TASKS_FERNET_KEY"),
        dev_user=os.environ.get("DEV_USER"),
    )
