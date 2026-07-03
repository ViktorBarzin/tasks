"""Skeleton smoke tests: liveness endpoint + identity middleware wiring."""

from fastapi.testclient import TestClient

from tasks_api.app import create_app


def test_healthz() -> None:
    client = TestClient(create_app())
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_api_rejects_missing_identity_header() -> None:
    client = TestClient(create_app())
    assert client.get("/api/me").status_code == 401


def test_me_trusts_authentik_header() -> None:
    client = TestClient(create_app())
    response = client.get("/api/me", headers={"X-Authentik-Username": "viktor"})
    assert response.status_code == 200
    assert response.json() == {"username": "viktor", "connected": False}
