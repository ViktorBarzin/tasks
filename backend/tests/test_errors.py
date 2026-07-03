"""Error envelope: every non-2xx /api response is ``{"error": {"code", "message"}}``.

The load-bearing case: Nextcloud revoking/rotating a stored app password turns
every CalDAV call into a 401 — the client must see a 401 envelope (its cue to
re-run Onboarding, ADR-0002), never a 500.
"""

from fastapi.testclient import TestClient

from tests.conftest import NC_USER, auth
from tests.fake_caldav import FakeNextcloud


def _assert_envelope(body: dict[str, object], code: str) -> None:
    error = body["error"]
    assert isinstance(error, dict)
    assert error["code"] == code
    assert isinstance(error["message"], str) and error["message"]


def test_missing_identity_is_401_envelope(client: TestClient) -> None:
    response = client.get("/api/me")
    assert response.status_code == 401
    _assert_envelope(response.json(), "unauthorized")


def test_not_connected_is_409_envelope(client: TestClient) -> None:
    response = client.get("/api/sync", headers=auth())
    assert response.status_code == 409
    _assert_envelope(response.json(), "not_connected")


def test_validation_error_is_422_envelope(client: TestClient) -> None:
    response = client.post("/api/onboard", json={"nc_username": "x"}, headers=auth())
    assert response.status_code == 422
    _assert_envelope(response.json(), "validation_error")


def test_validation_error_does_not_echo_app_password(client: TestClient) -> None:
    # CWE-209 (SEC-2): a validation failure must never serialize Pydantic's
    # ``input``, which for a missing sibling field is the whole submitted body —
    # here that carries the plaintext app password.
    secret = "super-secret-app-password"
    response = client.post("/api/onboard", json={"app_password": secret}, headers=auth())
    assert response.status_code == 422
    _assert_envelope(response.json(), "validation_error")
    assert secret not in response.text
    # The field that actually failed is still named, so the client can react.
    assert "nc_username" in response.json()["error"]["message"]


def test_revoked_app_password_turns_sync_into_401(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    fake_nc.users[NC_USER] = "rotated-by-nextcloud"  # revoke the stored password
    response = onboarded_client.get("/api/sync", headers=auth())
    assert response.status_code == 401
    _assert_envelope(response.json(), "nextcloud_unauthorized")


def test_revoked_app_password_turns_ops_into_401(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    fake_nc.users[NC_USER] = "rotated-by-nextcloud"
    response = onboarded_client.post(
        "/api/ops",
        json={"ops": [{"op_id": "op-1", "kind": "list_create", "list_id": "x", "name": "X"}]},
        headers=auth(),
    )
    assert response.status_code == 401
    _assert_envelope(response.json(), "nextcloud_unauthorized")
