"""Shared fixtures: temp sqlite DB (migrated by the app's own lifespan),
FakeNextcloud behind httpx.MockTransport — the whole suite runs offline."""

from collections.abc import Iterator
from pathlib import Path

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from tasks_api.app import create_app
from tests.fake_caldav import FakeNextcloud

GOLDEN_DIR = Path(__file__).parent / "golden"

NC_USER = "viktor-nc"
NC_PASS = "correct-horse-battery"


def load_golden(name: str) -> bytes:
    """Golden ICS as it travels on the wire (repo stores LF; CalDAV speaks CRLF)."""
    raw = (GOLDEN_DIR / name).read_bytes()
    return raw.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")


def unfold_lines(ics: bytes) -> list[bytes]:
    """RFC 5545 unfolding → one byte-string per logical property line."""
    unfolded = ics.replace(b"\r\n ", b"").replace(b"\r\n\t", b"")
    return [line for line in unfolded.split(b"\r\n") if line]


def auth(user: str = "viktor") -> dict[str, str]:
    return {"X-Authentik-Username": user}


@pytest.fixture
def fake_nc() -> FakeNextcloud:
    """A Nextcloud with one account, two task Lists (+1 VEVENT-only calendar)
    and realistic Apple/Nextcloud seed data."""
    fake = FakeNextcloud()
    fake.add_user(NC_USER, NC_PASS)
    fake.add_calendar(NC_USER, "personal", "Personal")
    fake.add_calendar(NC_USER, "work", "Work")
    fake.add_calendar(NC_USER, "contact_birthdays", "Birthdays", components={"VEVENT"})
    fake.put_ics(
        NC_USER,
        "personal",
        "6FD37E05-9AF0-4C0B-A9E9-D3B0E0F1A2B3.ics",
        load_golden("apple_recurring_alarm.ics"),
    )
    fake.put_ics(
        NC_USER,
        "personal",
        "0D9E1F2A-3B4C-5D6E-7F80-91A2B3C4D5E6.ics",
        load_golden("apple_allday_until.ics"),
    )
    fake.put_ics(
        NC_USER,
        "personal",
        "11C0FFEE-AAAA-BBBB-CCCC-000000000001.ics",
        load_golden("apple_daily_count.ics"),
    )
    fake.put_ics(
        NC_USER,
        "work",
        "nc-web-3f2a1b4c5d6e.ics",
        load_golden("nextcloud_simple.ics"),
    )
    return fake


@pytest.fixture
def app_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> str:
    """Point the app at a fresh sqlite file + a test Fernet key. Returns the key."""
    fernet_key = Fernet.generate_key().decode()
    monkeypatch.setenv("TASKS_DB_DSN", f"sqlite+aiosqlite:///{tmp_path}/tasks.db")
    monkeypatch.setenv("TASKS_FERNET_KEY", fernet_key)
    monkeypatch.setenv(
        "TASKS_CALDAV_BASE_URL", "https://nextcloud.viktorbarzin.me/remote.php/dav"
    )
    monkeypatch.delenv("DEV_USER", raising=False)
    return fernet_key


@pytest.fixture
def client(app_env: str, fake_nc: FakeNextcloud) -> Iterator[TestClient]:
    """App wired to the fake Nextcloud; lifespan migrates the temp DB."""
    app = create_app(caldav_transport=httpx.MockTransport(fake_nc.handler))
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def onboarded_client(client: TestClient) -> TestClient:
    response = client.post(
        "/api/onboard",
        json={"nc_username": NC_USER, "app_password": NC_PASS},
        headers=auth(),
    )
    assert response.status_code == 204, response.text
    return client
