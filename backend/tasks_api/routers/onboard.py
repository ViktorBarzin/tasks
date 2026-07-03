"""POST /api/onboard — connect a Nextcloud account (self-service, ADR-0002)."""

import logging

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from tasks_api import accounts
from tasks_api.auth import current_username
from tasks_api.config import Settings
from tasks_api.deps import build_engine, get_session, require_fernet_key, settings_dep
from tasks_api.errors import ApiError
from tasks_api.schemas import OnboardRequest

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/onboard", status_code=status.HTTP_204_NO_CONTENT)
async def onboard(
    payload: OnboardRequest,
    request: Request,
    username: str = Depends(current_username),
    session: AsyncSession = Depends(get_session),
    settings: Settings = Depends(settings_dep),
    fernet_key: str = Depends(require_fernet_key),
) -> None:
    """Contract: 204 after LIVE CalDAV validation; 401 if the credential is invalid.

    The app password is proven with a principal PROPFIND against Nextcloud,
    then Fernet-encrypted and upserted (re-onboarding rotates in place).
    """
    engine = build_engine(request, settings, payload.nc_username, payload.app_password)
    async with engine:
        valid = await engine.validate_credentials()
    if not valid:
        raise ApiError(401, "invalid_credentials", "Nextcloud rejected the app password")
    await accounts.upsert_account(
        session, username, payload.nc_username, payload.app_password, fernet_key
    )
    logger.info(
        "connected account onboarded",
        extra={"user": username, "nc_username": payload.nc_username},
    )
