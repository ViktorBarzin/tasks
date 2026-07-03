"""POST /api/onboard — connect a Nextcloud account (self-service, ADR-0002)."""

from fastapi import APIRouter, Depends, HTTPException, status

from tasks_api.auth import current_username
from tasks_api.schemas import OnboardRequest

router = APIRouter()


@router.post("/onboard", status_code=status.HTTP_204_NO_CONTENT)
async def onboard(
    payload: OnboardRequest, username: str = Depends(current_username)
) -> None:
    """Contract: 204 after LIVE CalDAV validation; 401 if the credential is invalid.

    Stub. The real implementation must:
      1. live-validate ``payload.app_password`` with a CalDAV PROPFIND against
         the current-user principal (401 on failure);
      2. Fernet-encrypt it (``TASKS_FERNET_KEY``, tasks_api.crypto) and upsert
         the ConnectedAccount row for ``username``.
    """
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="onboarding not implemented yet",
    )
