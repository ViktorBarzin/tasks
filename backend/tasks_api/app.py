"""App factory: API + metrics + (when built) the SvelteKit SPA — one container."""

from pathlib import Path

from fastapi import FastAPI
from prometheus_fastapi_instrumentator import Instrumentator
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

from tasks_api import __version__
from tasks_api.auth import AuthentikUserMiddleware
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


def create_app() -> FastAPI:
    """Build the FastAPI app: /healthz, /metrics, /api/*, and the SPA at /."""
    app = FastAPI(title="tasks", version=__version__)
    app.add_middleware(AuthentikUserMiddleware)

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
