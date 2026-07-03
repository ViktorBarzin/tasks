"""Skeleton smoke tests: liveness endpoint + identity middleware wiring."""

import pytest
from fastapi.testclient import TestClient

from tasks_api.app import create_app
from tests.conftest import auth

# The first two tests run without the lifespan on purpose: /healthz and the
# identity middleware must work before (and regardless of) DB startup.


def test_healthz() -> None:
    client = TestClient(create_app())
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_api_rejects_missing_identity_header() -> None:
    client = TestClient(create_app())
    assert client.get("/api/me").status_code == 401


def test_me_trusts_authentik_header(client: TestClient) -> None:
    response = client.get("/api/me", headers=auth())
    assert response.status_code == 200
    assert response.json() == {"username": "viktor", "connected": False}


def test_dev_user_env_is_the_identity_fallback(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("DEV_USER", "dev-viktor")
    response = client.get("/api/me")  # no X-Authentik-Username header
    assert response.status_code == 200
    assert response.json() == {"username": "dev-viktor", "connected": False}
    # A real header still wins over the fallback.
    assert client.get("/api/me", headers=auth()).json()["username"] == "viktor"
