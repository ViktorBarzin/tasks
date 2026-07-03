"""Environment-driven settings (no config files — the k8s stack injects env)."""

import os
from dataclasses import dataclass

USERNAME_HEADER = "X-Authentik-Username"
DEFAULT_DB_DSN = "sqlite+aiosqlite:///./tasks.db"
DEFAULT_CALDAV_BASE_URL = "https://nextcloud.viktorbarzin.me/remote.php/dav"
#: Household-local timezone for all-day recurrence roll-forward (SYNC-11): the
#: next occurrence of a date-valued DUE is computed in this wall-clock zone,
#: never UTC. Single source of truth, overridable via ``TASKS_LOCAL_TZ``.
DEFAULT_LOCAL_TIMEZONE = "Europe/Sofia"


@dataclass(frozen=True)
class Settings:
    """Runtime configuration, read from the environment.

    - ``db_dsn``: ``TASKS_DB_DSN`` — Postgres (asyncpg) in production, with a
      sqlite+aiosqlite fallback for dev/tests.
    - ``fernet_key``: ``TASKS_FERNET_KEY`` — encrypts Connected Account app
      passwords (ADR-0002); the key never lives in the DB.
    - ``dev_user``: ``DEV_USER`` — dev-only identity fallback when Authentik's
      forward-auth header is absent.
    - ``caldav_base_url``: ``TASKS_CALDAV_BASE_URL`` — the Nextcloud DAV root;
      the production default is the household Nextcloud.
    - ``local_timezone``: ``TASKS_LOCAL_TZ`` — the wall-clock zone for all-day
      recurrence roll-forward (SYNC-11); defaults to the household's Sofia.
    """

    db_dsn: str = DEFAULT_DB_DSN
    fernet_key: str | None = None
    dev_user: str | None = None
    caldav_base_url: str = DEFAULT_CALDAV_BASE_URL
    local_timezone: str = DEFAULT_LOCAL_TIMEZONE


def get_settings() -> Settings:
    """Read settings fresh from the environment (cheap; also keeps tests simple)."""
    return Settings(
        db_dsn=os.environ.get("TASKS_DB_DSN", DEFAULT_DB_DSN),
        fernet_key=os.environ.get("TASKS_FERNET_KEY"),
        dev_user=os.environ.get("DEV_USER"),
        caldav_base_url=os.environ.get("TASKS_CALDAV_BASE_URL", DEFAULT_CALDAV_BASE_URL),
        local_timezone=os.environ.get("TASKS_LOCAL_TZ", DEFAULT_LOCAL_TIMEZONE),
    )
