"""GET /api/me — who am I, and do I have a Connected Account yet?"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from tasks_api import accounts
from tasks_api.auth import current_username
from tasks_api.deps import get_session
from tasks_api.schemas import MeResponse

router = APIRouter()


@router.get("/me", response_model=MeResponse)
async def get_me(
    username: str = Depends(current_username),
    session: AsyncSession = Depends(get_session),
) -> MeResponse:
    """Contract: ``{"username": str, "connected": bool}``."""
    account = await accounts.get_account(session, username)
    return MeResponse(username=username, connected=account is not None)
