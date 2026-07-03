"""GET /api/sync — Delta Sync between the PWA Replica and Nextcloud (ADR-0001)."""

from fastapi import APIRouter, Depends, HTTPException, status

from tasks_api.auth import current_username
from tasks_api.schemas import SyncResponse

router = APIRouter()


@router.get("/sync", response_model=SyncResponse)
async def sync(cursor: str = "", username: str = Depends(current_username)) -> SyncResponse:
    """Contract: empty cursor ⇒ full snapshot (``full=true``); else changes since it.

    Stub. The real implementation drives per-List CalDAV sync-tokens (wrapped in
    the opaque base64-JSON cursor, server-side only) and maps VTODO ↔ Task.
    """
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="sync not implemented yet",
    )
