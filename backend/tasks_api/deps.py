"""FastAPI dependencies: DB session, settings, and the per-user CalDAV engine."""

from collections.abc import AsyncIterator

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from tasks_api import accounts
from tasks_api.auth import current_username
from tasks_api.caldav_engine import CalDAVEngine
from tasks_api.config import Settings, get_settings
from tasks_api.errors import ApiError
from tasks_api.models import ConnectedAccount


def settings_dep() -> Settings:
    return get_settings()


async def get_session(request: Request) -> AsyncIterator[AsyncSession]:
    factory: async_sessionmaker[AsyncSession] = request.app.state.session_factory
    async with factory() as session:
        yield session


def require_fernet_key(settings: Settings = Depends(settings_dep)) -> str:
    if not settings.fernet_key:
        raise ApiError(500, "server_misconfigured", "TASKS_FERNET_KEY is not set")
    return settings.fernet_key


async def require_account(
    username: str = Depends(current_username),
    session: AsyncSession = Depends(get_session),
) -> ConnectedAccount:
    """The caller's Connected Account — 409 tells the client to run Onboarding."""
    account = await accounts.get_account(session, username)
    if account is None:
        raise ApiError(409, "not_connected", "no Connected Account; onboarding required")
    return account


def build_engine(
    request: Request, settings: Settings, nc_username: str, app_password: str
) -> CalDAVEngine:
    """CalDAV engine for explicit credentials (onboarding validates them live).

    ``app.state.caldav_transport`` (set by tests) swaps the network for an
    ``httpx.MockTransport`` — production leaves it None.
    """
    return CalDAVEngine(
        base_url=settings.caldav_base_url,
        nc_username=nc_username,
        app_password=app_password,
        transport=request.app.state.caldav_transport,
    )


async def engine_for_account(
    request: Request,
    account: ConnectedAccount = Depends(require_account),
    settings: Settings = Depends(settings_dep),
    fernet_key: str = Depends(require_fernet_key),
) -> AsyncIterator[CalDAVEngine]:
    """CalDAV engine authenticated as the caller's Connected Account."""
    engine = build_engine(
        request, settings, account.nc_username, accounts.account_password(account, fernet_key)
    )
    async with engine:
        yield engine
