"""POST /api/ops — replay a batch of client Ops against Nextcloud (ADR-0001)."""

from fastapi import APIRouter, Depends, HTTPException, status

from tasks_api.auth import current_username
from tasks_api.schemas import OpsRequest, OpsResponse

router = APIRouter()


@router.post("/ops", response_model=OpsResponse)
async def apply_ops(
    payload: OpsRequest, username: str = Depends(current_username)
) -> OpsResponse:
    """Contract: one OpResult per Op — applied | lww_reapplied | duplicate | error.

    Stub. The real implementation MUST replay idempotently: re-sent op_ids and
    already-existing create UIDs return "duplicate" and are never double-applied;
    a stale-ETag 412 triggers the Silent-LWW re-apply ("lww_reapplied").
    """
    raise HTTPException(
        status_code=status.HTTP_501_NOT_IMPLEMENTED,
        detail="ops replay not implemented yet",
    )
