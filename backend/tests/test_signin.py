"""GET /api/signin — the popup landing page for the §I re-login.

The endpoint's whole job is to be GATED: it lives under /api, so Traefik→
Authentik must complete a login before the popup can ever reach it. Arriving
here at all is the proof of a fresh session, and the page then closes itself.
"""

from fastapi.testclient import TestClient

from tasks_api.app import create_app
from tests.conftest import auth


def test_signin_requires_identity() -> None:
    """Unauthenticated = the forward-auth wall, exactly like the rest of /api.

    (In production the proxy 302s this to the SSO login instead of ever
    reaching the app — the 401 is the app-side backstop.)
    """
    client = TestClient(create_app())
    assert client.get("/api/signin").status_code == 401


def test_signin_serves_a_self_closing_page(client: TestClient) -> None:
    response = client.get("/api/signin", headers=auth())
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    # The popup must close itself; the opener's /api/me poll is the backstop.
    assert "window.close()" in response.text


def test_signin_page_is_never_cached(client: TestClient) -> None:
    """A cached 200 would let a walled popup look successful."""
    response = client.get("/api/signin", headers=auth())
    assert "no-store" in response.headers["cache-control"]
