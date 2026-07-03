"""GET /api/me — who am I, and do I have a Connected Account yet?"""

from fastapi import APIRouter, Depends

from tasks_api.auth import current_username
from tasks_api.schemas import MeResponse

router = APIRouter()


@router.get("/me", response_model=MeResponse)
async def get_me(username: str = Depends(current_username)) -> MeResponse:
    """Contract: ``{"username": str, "connected": bool}``.

    Stub: ``connected`` is hard-coded False until the onboarding slice wires the
    credential-store lookup (ConnectedAccount row for this username).
    """
    return MeResponse(username=username, connected=False)
