"""Guarded writes through an RFC-violating edge proxy (openresty ingress).

Discovered live on 2026-07-03 against ``nextcloud.viktorbarzin.me``: the
ingress answers conditional WRITES itself and never forwards them upstream —

- ``PUT`` with ``If-None-Match: *`` → empty ``304`` (a status RFC 9110 §15.4.5
  reserves for GET/HEAD, so a compliant origin can never send it for PUT);
- ``PUT``/``DELETE`` with ``If-Match`` → blanket ``412``, even when the tag
  matches the current entity.

The engine detects both signatures and degrades to verify-then-retry: on an
impossible 304 it re-checks existence with a GET before an unguarded PUT; on a
412 it re-reads the ETag and retries unguarded only when the precondition
provably still holds (a differing tag stays a genuine 412 for the Silent-LWW
loop). Against a compliant server the fallback never engages — the rest of the
suite pins that.
"""

from collections.abc import Callable, Iterator

import httpx
import pytest
from fastapi.testclient import TestClient

from tasks_api.app import create_app
from tests.conftest import NC_PASS, NC_USER, auth
from tests.fake_caldav import FakeNextcloud
from tests.test_ops import op, post_ops
from tests.test_sync import sync, task_by_uid

EDGE_INTERCEPTS = ("PUT", "DELETE")


def broken_edge(fake: FakeNextcloud) -> Callable[[httpx.Request], httpx.Response]:
    """The observed openresty behaviour: conditional writes die at the edge."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT" and request.headers.get("If-None-Match") == "*":
            return httpx.Response(304)
        if request.method in EDGE_INTERCEPTS and "If-Match" in request.headers:
            return httpx.Response(412)
        return fake.handler(request)

    return handler


@pytest.fixture
def edge_client(app_env: str, fake_nc: FakeNextcloud) -> Iterator[TestClient]:
    """The app talking to FakeNextcloud only through the broken edge."""
    app = create_app(caldav_transport=httpx.MockTransport(broken_edge(fake_nc)))
    with TestClient(app) as client:
        response = client.post(
            "/api/onboard",
            json={"nc_username": NC_USER, "app_password": NC_PASS},
            headers=auth(),
        )
        assert response.status_code == 204, response.text
        yield client


def test_create_applies_through_broken_edge(
    edge_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    results = post_ops(
        edge_client,
        op("task_create", "e1", uid="edge-uid-1", list_id="work", title="Through the edge"),
    )
    assert results == [{"op_id": "e1", "status": "applied", "error": None}]
    stored = fake_nc.get_object(NC_USER, "work", "edge-uid-1.ics")
    assert b"SUMMARY:Through the edge" in stored.ics


def test_create_existing_uid_is_still_duplicate_through_broken_edge(
    edge_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    post_ops(
        edge_client,
        op("task_create", "e1", uid="edge-uid-1", list_id="work", title="First wins"),
    )
    # New op_id (journal miss) + same UID: the existence check must still
    # answer "duplicate" even though the If-None-Match guard cannot get through.
    results = post_ops(
        edge_client,
        op("task_create", "e2", uid="edge-uid-1", list_id="work", title="Usurper"),
    )
    assert results == [{"op_id": "e2", "status": "duplicate", "error": None}]
    stored = fake_nc.get_object(NC_USER, "work", "edge-uid-1.ics")
    assert b"SUMMARY:First wins" in stored.ics


def test_update_applies_through_broken_edge(
    edge_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    results = post_ops(
        edge_client,
        op("task_update", "e1", uid="nc-web-3f2a1b4c5d6e", list_id="work", title="Edited"),
    )
    assert results == [{"op_id": "e1", "status": "applied", "error": None}]
    stored = fake_nc.get_object(NC_USER, "work", "nc-web-3f2a1b4c5d6e.ics")
    assert b"SUMMARY:Edited" in stored.ics
    assert task_by_uid(sync(edge_client), "nc-web-3f2a1b4c5d6e")["title"] == "Edited"


def test_concurrent_edit_still_lww_through_broken_edge(
    edge_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    """A genuinely stale tag must stay a 412: refetch, re-apply, lww_reapplied."""
    filename = "nc-web-3f2a1b4c5d6e.ics"

    def concurrent_edit() -> None:
        current = fake_nc.get_object(NC_USER, "work", filename)
        edited = current.ics.replace(
            b"SUMMARY:Ring insurer about policy renewal", b"SUMMARY:Renamed elsewhere"
        )
        assert edited != current.ics  # the seed summary moved — update this test
        fake_nc.put_ics(NC_USER, "work", filename, edited)

    fake_nc.add_after_get_hook(filename, concurrent_edit)
    results = post_ops(
        edge_client,
        op("task_update", "e1", uid="nc-web-3f2a1b4c5d6e", list_id="work", notes="mine"),
    )
    assert results == [{"op_id": "e1", "status": "lww_reapplied", "error": None}]
    stored = fake_nc.get_object(NC_USER, "work", filename)
    assert b"SUMMARY:Renamed elsewhere" in stored.ics  # concurrent edit survives
    assert b"DESCRIPTION:mine" in stored.ics  # our field lands on top of it


def test_complete_applies_through_broken_edge(
    edge_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    results = post_ops(
        edge_client, op("task_complete", "e1", uid="nc-web-3f2a1b4c5d6e", list_id="work")
    )
    assert results == [{"op_id": "e1", "status": "applied", "error": None}]
    stored = fake_nc.get_object(NC_USER, "work", "nc-web-3f2a1b4c5d6e.ics")
    assert b"STATUS:COMPLETED" in stored.ics


def test_delete_applies_through_broken_edge(
    edge_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    results = post_ops(
        edge_client, op("task_delete", "e1", uid="nc-web-3f2a1b4c5d6e", list_id="work")
    )
    assert results == [{"op_id": "e1", "status": "applied", "error": None}]
    assert "nc-web-3f2a1b4c5d6e.ics" not in fake_nc.calendars[NC_USER]["work"].objects


def test_edge_that_kills_every_put_surfaces_an_error(
    app_env: str, fake_nc: FakeNextcloud
) -> None:
    """If even the unguarded retry is swallowed, fail loudly — never loop."""

    def hostile(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT":
            return httpx.Response(304)
        return fake_nc.handler(request)

    app = create_app(caldav_transport=httpx.MockTransport(hostile))
    with TestClient(app) as client:
        response = client.post(
            "/api/onboard",
            json={"nc_username": NC_USER, "app_password": NC_PASS},
            headers=auth(),
        )
        assert response.status_code == 204, response.text
        results = post_ops(
            client,
            op("task_create", "e1", uid="edge-uid-1", list_id="work", title="Doomed"),
        )
    assert results[0]["status"] == "error"
    assert "304" in (results[0]["error"] or "")
