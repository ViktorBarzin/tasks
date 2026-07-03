"""Async SQLAlchemy plumbing.

Postgres (asyncpg) in production, sqlite+aiosqlite for dev/tests — both via
``TASKS_DB_DSN``. Schema changes go through alembic (backend/alembic), never
``metadata.create_all``.
"""

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from tasks_api.config import get_settings


class Base(DeclarativeBase):
    """Declarative base for all tasks tables."""


def create_engine(dsn: str | None = None) -> AsyncEngine:
    """Engine for the configured DSN (override for tests)."""
    return create_async_engine(dsn or get_settings().db_dsn)


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    """Session factory bound to *engine*."""
    return async_sessionmaker(engine, expire_on_commit=False)
