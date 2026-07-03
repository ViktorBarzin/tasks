"""App factory: API + metrics + (when built) the SvelteKit SPA — one container."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import anyio
import httpx
from fastapi import FastAPI
from prometheus_fastapi_instrumentator import Instrumentator
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

from tasks_api import __version__, db, migrations
from tasks_api.auth import AuthentikUserMiddleware
from tasks_api.errors import install_error_handlers
from tasks_api.logging_setup import configure_logging
from tasks_api.routers import api_router

# backend/tasks_api/app.py → repo root → frontend/build (adapter-static output).
# The Dockerfile reproduces this layout (/app/backend + /app/frontend/build).
FRONTEND_BUILD_DIR = Path(__file__).resolve().parents[2] / "frontend" / "build"


class SPAStaticFiles(StaticFiles):
    """Static files with an index.html fallback so client-side routes deep-link."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404:
                return await super().get_response("index.html", scope)
            raise


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Migrate the DB to head, then open the engine for the app's lifetime.

    Alembic drives its own (async) engine via ``asyncio.run`` inside
    ``alembic/env.py``, so it runs on a worker thread here.
    """
    await anyio.to_thread.run_sync(migrations.upgrade_to_head)
    engine = db.create_engine()
    app.state.db_engine = engine
    app.state.session_factory = db.create_session_factory(engine)
    try:
        yield
    finally:
        await engine.dispose()


def create_app(caldav_transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    """Build the FastAPI app: /healthz, /metrics, /api/*, and the SPA at /.

    ``caldav_transport`` lets tests swap Nextcloud for an
    ``httpx.MockTransport``; production passes nothing (real network).
    """
    configure_logging()
    app = FastAPI(title="tasks", version=__version__, lifespan=_lifespan)
    app.state.caldav_transport = caldav_transport
    app.add_middleware(AuthentikUserMiddleware)
    install_error_handlers(app)

    @app.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    Instrumentator().instrument(app).expose(app, endpoint="/metrics", include_in_schema=False)

    app.include_router(api_router, prefix="/api")

    # Serve the built SPA when present — absent in dev (vite dev server proxies
    # to us instead) and in backend-only test runs.
    if FRONTEND_BUILD_DIR.is_dir():
        app.mount("/", SPAStaticFiles(directory=FRONTEND_BUILD_DIR, html=True), name="spa")

    return app


app = create_app()
