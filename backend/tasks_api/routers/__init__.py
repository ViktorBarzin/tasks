"""The /api router tree. Every route requires the Authentik identity (tasks_api.auth)."""

from fastapi import APIRouter

from tasks_api.routers import me, onboard, ops, signin, sync

api_router = APIRouter()
api_router.include_router(me.router)
api_router.include_router(onboard.router)
api_router.include_router(sync.router)
api_router.include_router(ops.router)
api_router.include_router(signin.router)
