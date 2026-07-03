"""Onboarding (ADR-0002): live CalDAV validation, Fernet-encrypted storage,
re-onboarding rotation. All network is the FakeNextcloud transport — offline."""

from pathlib import Path

import pytest
from cryptography.fernet import Fernet, InvalidToken
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncEngine

from tasks_api import accounts, db, migrations
from tests.conftest import NC_PASS, NC_USER, auth
from tests.fake_caldav import FakeNextcloud

# -- API level (through the app, FakeNextcloud transport) ---------------------


def test_onboard_valid_credentials_204_then_connected(client: TestClient) -> None:
    response = client.post(
        "/api/onboard",
        json={"nc_username": NC_USER, "app_password": NC_PASS},
        headers=auth(),
    )
    assert response.status_code == 204
    me = client.get("/api/me", headers=auth()).json()
    assert me == {"username": "viktor", "connected": True}


def test_onboard_wrong_password_401_and_stores_nothing(client: TestClient) -> None:
    response = client.post(
        "/api/onboard",
        json={"nc_username": NC_USER, "app_password": "wrong"},
        headers=auth(),
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_credentials"
    me = client.get("/api/me", headers=auth()).json()
    assert me["connected"] is False


def test_onboard_unknown_user_401(client: TestClient) -> None:
    response = client.post(
        "/api/onboard",
        json={"nc_username": "nobody", "app_password": "whatever"},
        headers=auth(),
    )
    assert response.status_code == 401


def test_reonboard_rotates_credential_in_place(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    # Nextcloud rotates the app password → old credential dies → re-onboard.
    fake_nc.users[NC_USER] = "fresh-app-password"
    assert onboarded_client.get("/api/sync", headers=auth()).status_code == 401

    response = onboarded_client.post(
        "/api/onboard",
        json={"nc_username": NC_USER, "app_password": "fresh-app-password"},
        headers=auth(),
    )
    assert response.status_code == 204
    assert onboarded_client.get("/api/sync", headers=auth()).status_code == 200


def test_onboard_without_fernet_key_is_500(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("TASKS_FERNET_KEY")
    response = client.post(
        "/api/onboard",
        json={"nc_username": NC_USER, "app_password": NC_PASS},
        headers=auth(),
    )
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "server_misconfigured"


def test_accounts_are_per_authentik_user(client: TestClient) -> None:
    response = client.post(
        "/api/onboard",
        json={"nc_username": NC_USER, "app_password": NC_PASS},
        headers=auth("anca"),
    )
    assert response.status_code == 204
    assert client.get("/api/me", headers=auth("anca")).json()["connected"] is True
    assert client.get("/api/me", headers=auth("viktor")).json()["connected"] is False


# -- storage level (accounts module against a migrated sqlite) -----------------


@pytest.fixture
def unit_dsn(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    dsn = f"sqlite+aiosqlite:///{tmp_path}/unit.db"
    monkeypatch.setenv("TASKS_DB_DSN", dsn)
    migrations.upgrade_to_head()  # schema via alembic, same as production
    return dsn


@pytest.fixture
async def unit_engine(unit_dsn: str) -> AsyncEngine:
    engine = db.create_engine(unit_dsn)
    yield engine
    await engine.dispose()


async def test_upsert_stores_ciphertext_not_plaintext(unit_engine: AsyncEngine) -> None:
    key = Fernet.generate_key().decode()
    factory = db.create_session_factory(unit_engine)
    async with factory() as session:
        await accounts.upsert_account(session, "viktor", NC_USER, "s3cret", key)
    async with factory() as session:
        account = await accounts.get_account(session, "viktor")
        assert account is not None
        assert account.nc_username == NC_USER
        assert b"s3cret" not in account.enc_app_password
        assert accounts.account_password(account, key) == "s3cret"


async def test_upsert_rotates_in_place(unit_engine: AsyncEngine) -> None:
    key = Fernet.generate_key().decode()
    factory = db.create_session_factory(unit_engine)
    async with factory() as session:
        await accounts.upsert_account(session, "viktor", NC_USER, "old", key)
        await accounts.upsert_account(session, "viktor", "viktor-renamed", "new", key)
    async with factory() as session:
        account = await accounts.get_account(session, "viktor")
        assert account is not None
        assert account.nc_username == "viktor-renamed"
        assert accounts.account_password(account, key) == "new"


async def test_wrong_key_cannot_decrypt(unit_engine: AsyncEngine) -> None:
    key = Fernet.generate_key().decode()
    factory = db.create_session_factory(unit_engine)
    async with factory() as session:
        await accounts.upsert_account(session, "viktor", NC_USER, "s3cret", key)
        account = await accounts.get_account(session, "viktor")
        assert account is not None
        with pytest.raises(InvalidToken):
            accounts.account_password(account, Fernet.generate_key().decode())


async def test_get_account_unknown_user_is_none(unit_engine: AsyncEngine) -> None:
    factory = db.create_session_factory(unit_engine)
    async with factory() as session:
        assert await accounts.get_account(session, "ghost") is None
