"""GET /api/sync — Delta Sync contract (ADR-0001), against FakeNextcloud.

Empty cursor ⇒ full snapshot; a returned cursor replays only what changed;
invalid/expired cursors escalate to a full snapshot instead of erroring.
External edits are injected via the fake's state hooks, as Apple/Nextcloud
web would make them.
"""

from fastapi.testclient import TestClient

from tasks_api import cursor as cursor_codec
from tests.conftest import NC_USER, auth, load_golden
from tests.fake_caldav import FakeNextcloud

APPLE_TIMED_UID = "6FD37E05-9AF0-4C0B-A9E9-D3B0E0F1A2B3"
APPLE_ALLDAY_UID = "0D9E1F2A-3B4C-5D6E-7F80-91A2B3C4D5E6"
APPLE_DAILY_UID = "11C0FFEE-AAAA-BBBB-CCCC-000000000001"
NC_SIMPLE_UID = "nc-web-3f2a1b4c5d6e"


def sync(client: TestClient, cursor: str = "") -> dict:
    response = client.get("/api/sync", params={"cursor": cursor}, headers=auth())
    assert response.status_code == 200, response.text
    return response.json()


def task_by_uid(payload: dict, uid: str) -> dict:
    matches = [t for t in payload["tasks"] if t["uid"] == uid]
    assert len(matches) == 1, f"expected exactly one {uid}, got {len(matches)}"
    return matches[0]


# -- full snapshot ---------------------------------------------------------------


def test_empty_cursor_full_snapshot_shape(onboarded_client: TestClient) -> None:
    payload = sync(onboarded_client)
    assert set(payload) == {"cursor", "full", "lists", "tasks"}
    assert payload["full"] is True
    assert payload["cursor"]

    # VTODO-capable lists only — the VEVENT-only Birthdays calendar is not a List.
    assert {(li["id"], li["name"], li["deleted"]) for li in payload["lists"]} == {
        ("personal", "Personal", False),
        ("work", "Work", False),
    }
    assert {t["uid"] for t in payload["tasks"]} == {
        APPLE_TIMED_UID,
        APPLE_ALLDAY_UID,
        APPLE_DAILY_UID,
        NC_SIMPLE_UID,
    }


def test_full_snapshot_task_fields_match_contract(onboarded_client: TestClient) -> None:
    payload = sync(onboarded_client)

    timed = task_by_uid(payload, APPLE_TIMED_UID)
    assert set(timed) == {
        "uid", "list_id", "title", "notes", "due", "due_has_time", "priority",
        "sort_order", "completed", "completed_at", "recurring", "deleted",
    }
    assert timed["list_id"] == "personal"
    assert timed["due"] == "2026-07-01T09:00:00+03:00"
    assert timed["due_has_time"] is True
    assert timed["priority"] == 1
    assert timed["sort_order"] == 740609486  # Apple-era X-APPLE-SORT-ORDER, honored
    assert timed["completed"] is False
    assert timed["recurring"] is True
    assert timed["deleted"] is False

    allday = task_by_uid(payload, APPLE_ALLDAY_UID)
    assert allday["due"] == "2026-06-15"
    assert allday["due_has_time"] is False
    assert allday["completed"] is True
    assert allday["completed_at"] == "2026-06-15T19:15:00+00:00"

    simple = task_by_uid(payload, NC_SIMPLE_UID)
    assert simple["list_id"] == "work"
    assert simple["due"] is None
    assert simple["priority"] == 0
    assert simple["recurring"] is False
    assert simple["sort_order"] is None  # no X-APPLE-SORT-ORDER on the object


def test_undecodable_cursor_is_a_full_snapshot(onboarded_client: TestClient) -> None:
    payload = sync(onboarded_client, cursor="corrupted-blob-from-2019")
    assert payload["full"] is True
    assert len(payload["tasks"]) == 4


def test_list_order_ships_in_snapshot_and_delta(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    # calendar-order (Apple ns) read by the home PROPFIND → TaskList.order;
    # unset property (404 propstat) → null (contract delta v1.2 §1).
    fake_nc.calendars[NC_USER]["work"].order = 1
    payload = sync(onboarded_client)
    assert {(li["id"], li["order"]) for li in payload["lists"]} == {
        ("personal", None),
        ("work", 1),
    }
    # Lists ship whole in every response, so an order change (made by another
    # device) propagates through a delta without any sync-token involvement.
    fake_nc.calendars[NC_USER]["work"].order = 0
    fake_nc.calendars[NC_USER]["personal"].order = 2
    delta = sync(onboarded_client, cursor=payload["cursor"])
    assert delta["full"] is False
    assert {(li["id"], li["order"]) for li in delta["lists"]} == {
        ("personal", 2),
        ("work", 0),
    }


def test_full_snapshot_list_fields_match_contract(onboarded_client: TestClient) -> None:
    # The exact TaskList key-set on the wire (contract delta v1.4 §1).
    payload = sync(onboarded_client)
    for li in payload["lists"]:
        assert set(li) == {"id", "name", "order", "sort_mode", "deleted"}


def test_list_sort_mode_ships_in_snapshot_and_delta(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    # The custom {urn:viktorbarzin:tasks}sort-mode dead property, read by the
    # same home PROPFIND → TaskList.sort_mode; unset (404 propstat) → null
    # (contract delta v1.4 §1).
    fake_nc.calendars[NC_USER]["work"].sort_mode = "priority"
    payload = sync(onboarded_client)
    assert {(li["id"], li["sort_mode"]) for li in payload["lists"]} == {
        ("personal", None),
        ("work", "priority"),
    }
    # Lists ship whole in every response, so a mode change (made on another
    # device) propagates through a delta without any sync-token involvement.
    fake_nc.calendars[NC_USER]["work"].sort_mode = "due"
    fake_nc.calendars[NC_USER]["personal"].sort_mode = "custom"
    delta = sync(onboarded_client, cursor=payload["cursor"])
    assert delta["full"] is False
    assert {(li["id"], li["sort_mode"]) for li in delta["lists"]} == {
        ("personal", "custom"),
        ("work", "due"),
    }


def test_list_sort_mode_foreign_value_reads_as_unset(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    # A dead property another client scribbled on: not one of the three modes
    # ⇒ null on the wire, never echoed (contract delta v1.4 §0/§1).
    fake_nc.calendars[NC_USER]["work"].sort_mode = "alphabetical"
    payload = sync(onboarded_client)
    assert {(li["id"], li["sort_mode"]) for li in payload["lists"]} == {
        ("personal", None),
        ("work", None),
    }


# -- delta -----------------------------------------------------------------------


def test_quiet_delta_is_empty(onboarded_client: TestClient) -> None:
    first = sync(onboarded_client)
    second = sync(onboarded_client, cursor=first["cursor"])
    assert second["full"] is False
    assert second["tasks"] == []
    # Lists still listed (names may change server-side), none deleted.
    assert {li["id"] for li in second["lists"] if not li["deleted"]} == {"personal", "work"}
    third = sync(onboarded_client, cursor=second["cursor"])
    assert third["tasks"] == []


def test_external_edit_shows_up_in_delta(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    cursor = sync(onboarded_client)["cursor"]
    edited = load_golden("nextcloud_simple.ics").replace(
        b"SUMMARY:Ring insurer about policy renewal", b"SUMMARY:Ring insurer TODAY"
    )
    fake_nc.put_ics(NC_USER, "work", f"{NC_SIMPLE_UID}.ics", edited)

    payload = sync(onboarded_client, cursor=cursor)
    assert payload["full"] is False
    task = task_by_uid(payload, NC_SIMPLE_UID)
    assert task["title"] == "Ring insurer TODAY"
    assert task["deleted"] is False
    # Nothing else re-shipped.
    assert len(payload["tasks"]) == 1


def test_external_delete_ships_a_tombstone(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    cursor = sync(onboarded_client)["cursor"]
    fake_nc.delete_ics(NC_USER, "personal", f"{APPLE_DAILY_UID}.ics")

    payload = sync(onboarded_client, cursor=cursor)
    assert payload["full"] is False
    tombstone = task_by_uid(payload, APPLE_DAILY_UID)
    assert tombstone["deleted"] is True
    assert tombstone["list_id"] == "personal"


def test_delete_tombstone_carries_true_uid_not_filename(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    # Apple-legacy object: filename != UID. Its delete tombstone must carry the
    # real UID (as clients store it), not the filename-derived guess, or the
    # object becomes an undeletable ghost in the Replica (SYNC-6 / contract D).
    oddball = load_golden("nextcloud_simple.ics").replace(
        b"UID:nc-web-3f2a1b4c5d6e", b"UID:oddly-named-task"
    )
    fake_nc.put_ics(NC_USER, "work", "1D5C9A2E-legacy-apple-name.ics", oddball)
    cursor = sync(onboarded_client)["cursor"]  # full snapshot builds the href→UID index

    fake_nc.delete_ics(NC_USER, "work", "1D5C9A2E-legacy-apple-name.ics")
    payload = sync(onboarded_client, cursor=cursor)
    assert payload["full"] is False
    tombstone = task_by_uid(payload, "oddly-named-task")
    assert tombstone["deleted"] is True
    assert tombstone["list_id"] == "work"
    # The filename-derived guess must never appear as a phantom tombstone.
    assert not any(t["uid"] == "1D5C9A2E-legacy-apple-name" for t in payload["tasks"])


def test_delete_tombstone_uses_filename_when_uid_matches(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    # The common case (filename == UID) is not indexed and still tombstones
    # correctly via the filename fallback.
    cursor = sync(onboarded_client)["cursor"]
    fake_nc.delete_ics(NC_USER, "personal", f"{APPLE_DAILY_UID}.ics")
    payload = sync(onboarded_client, cursor=cursor)
    assert task_by_uid(payload, APPLE_DAILY_UID)["deleted"] is True


def test_external_create_shows_up_in_delta(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    cursor = sync(onboarded_client)["cursor"]
    fresh = load_golden("nextcloud_simple.ics").replace(
        b"UID:nc-web-3f2a1b4c5d6e", b"UID:nc-web-000000000new"
    )
    fake_nc.put_ics(NC_USER, "work", "nc-web-000000000new.ics", fresh)

    payload = sync(onboarded_client, cursor=cursor)
    assert payload["full"] is False
    assert task_by_uid(payload, "nc-web-000000000new")["title"] == (
        "Ring insurer about policy renewal"
    )


def test_new_list_ships_whole_in_delta(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    cursor = sync(onboarded_client)["cursor"]
    fake_nc.add_calendar(NC_USER, "garden", "Garden")
    fresh = load_golden("nextcloud_simple.ics").replace(
        b"UID:nc-web-3f2a1b4c5d6e", b"UID:garden-task-1"
    )
    fake_nc.put_ics(NC_USER, "garden", "garden-task-1.ics", fresh)

    payload = sync(onboarded_client, cursor=cursor)
    assert payload["full"] is False
    assert ("garden", "Garden", False) in {
        (li["id"], li["name"], li["deleted"]) for li in payload["lists"]
    }
    assert task_by_uid(payload, "garden-task-1")["list_id"] == "garden"
    # And the new cursor covers the new List from now on.
    quiet = sync(onboarded_client, cursor=payload["cursor"])
    assert quiet["tasks"] == []


def test_deleted_list_ships_a_list_tombstone(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    cursor = sync(onboarded_client)["cursor"]
    del fake_nc.calendars[NC_USER]["work"]

    payload = sync(onboarded_client, cursor=cursor)
    assert payload["full"] is False
    assert ("work", True) in {(li["id"], li["deleted"]) for li in payload["lists"]}
    assert ("personal", False) in {(li["id"], li["deleted"]) for li in payload["lists"]}
    # Tombstones carry the contract's null sort_mode (v1.4 §1).
    tombstone = next(li for li in payload["lists"] if li["deleted"])
    assert tombstone["sort_mode"] is None


def test_expired_sync_token_escalates_to_full_snapshot(
    onboarded_client: TestClient,
) -> None:
    # A cursor whose tokens the server no longer honors (sabre 403s them).
    bogus = cursor_codec.encode_cursor(
        {"personal": "http://elsewhere/ns/sync/999", "work": "http://elsewhere/ns/sync/999"}
    )
    payload = sync(onboarded_client, cursor=bogus)
    assert payload["full"] is True
    assert len(payload["tasks"]) == 4
    # The fresh cursor works for deltas again.
    quiet = sync(onboarded_client, cursor=payload["cursor"])
    assert quiet["full"] is False
    assert quiet["tasks"] == []


def test_unparseable_object_is_skipped_not_fatal(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    fake_nc.put_ics(
        NC_USER,
        "work",
        "corrupt.ics",
        b"BEGIN:VCALENDAR\r\nBEGIN:VTODO\r\nUID\r\nEND:VCALENDAR\r\n",
    )
    payload = sync(onboarded_client)
    assert payload["full"] is True
    assert {t["uid"] for t in payload["tasks"]} == {
        APPLE_TIMED_UID,
        APPLE_ALLDAY_UID,
        APPLE_DAILY_UID,
        NC_SIMPLE_UID,
    }
