"""POST /api/ops — the replay contract (ADR-0001), against FakeNextcloud.

The three guarantees under test: idempotent replay (op_id journal + create-UID
existence ⇒ ``duplicate``, never a double-apply), Silent LWW (stale ETag 412 ⇒
refetch + re-apply ⇒ ``lww_reapplied``), and per-Op isolation (one bad Op
errors, the rest of the batch still applies, results stay ordered).
"""

from datetime import UTC, datetime

from fastapi.testclient import TestClient

from tests.conftest import NC_USER, auth, load_golden
from tests.fake_caldav import FakeNextcloud
from tests.test_sync import NC_SIMPLE_UID, sync, task_by_uid

INFINITE_DAILY_UID = "infinite-daily-1"
INFINITE_DAILY = (
    b"BEGIN:VCALENDAR\r\n"
    b"VERSION:2.0\r\n"
    b"PRODID:-//Apple Inc.//iOS 18.5//EN\r\n"
    b"BEGIN:VTODO\r\n"
    b"CREATED:20260601T060000Z\r\n"
    b"DTSTAMP:20260628T054500Z\r\n"
    b"DUE:20260701T054500Z\r\n"
    b"LAST-MODIFIED:20260628T054500Z\r\n"
    b"RRULE:FREQ=DAILY\r\n"
    b"SEQUENCE:0\r\n"
    b"STATUS:NEEDS-ACTION\r\n"
    b"SUMMARY:Infinite daily\r\n"
    b"UID:infinite-daily-1\r\n"
    b"END:VTODO\r\n"
    b"END:VCALENDAR\r\n"
)


def post_ops(client: TestClient, *ops: dict) -> list[dict]:
    response = client.post("/api/ops", json={"ops": list(ops)}, headers=auth())
    assert response.status_code == 200, response.text
    results: list[dict] = response.json()["results"]
    assert [r["op_id"] for r in results] == [o["op_id"] for o in ops]  # ordered
    return results


def op(kind: str, op_id: str, **fields: object) -> dict:
    return {"op_id": op_id, "kind": kind, **fields}


# -- task_create -----------------------------------------------------------------


def test_create_applied_and_visible(onboarded_client: TestClient) -> None:
    results = post_ops(
        onboarded_client,
        op(
            "task_create",
            "c1",
            uid="client-uid-1",
            list_id="work",
            title="Write the report",
            notes="by Friday",
            due="2026-07-10T09:00:00+00:00",
            due_has_time=True,
            priority=5,
        ),
    )
    assert results == [{"op_id": "c1", "status": "applied", "error": None}]
    task = task_by_uid(sync(onboarded_client), "client-uid-1")
    assert task["list_id"] == "work"
    assert task["title"] == "Write the report"
    assert task["notes"] == "by Friday"
    assert task["due"] == "2026-07-10T09:00:00+00:00"
    assert task["priority"] == 5
    assert task["completed"] is False


def test_create_replayed_op_id_is_duplicate(onboarded_client: TestClient) -> None:
    create = op("task_create", "c1", uid="client-uid-1", list_id="work", title="Once")
    assert post_ops(onboarded_client, create)[0]["status"] == "applied"
    # Same batch re-POSTed after a flaky network — the journal answers.
    assert post_ops(onboarded_client, create)[0]["status"] == "duplicate"
    assert len([t for t in sync(onboarded_client)["tasks"] if t["uid"] == "client-uid-1"]) == 1


def test_create_same_uid_new_op_id_is_duplicate(onboarded_client: TestClient) -> None:
    # Client lost its journal (reinstall) but the UID it generated survives.
    post_ops(
        onboarded_client, op("task_create", "c1", uid="client-uid-1", list_id="work", title="A")
    )
    results = post_ops(
        onboarded_client,
        op("task_create", "c2", uid="client-uid-1", list_id="work", title="A again"),
    )
    assert results[0]["status"] == "duplicate"
    assert task_by_uid(sync(onboarded_client), "client-uid-1")["title"] == "A"  # first write wins


def test_create_duplicate_op_id_within_one_batch(onboarded_client: TestClient) -> None:
    results = post_ops(
        onboarded_client,
        op("task_create", "c1", uid="u-1", list_id="work", title="A"),
        op("task_create", "c1", uid="u-1", list_id="work", title="A"),
    )
    assert [r["status"] for r in results] == ["applied", "duplicate"]


def test_create_into_missing_list_errors_batch_continues(
    onboarded_client: TestClient,
) -> None:
    results = post_ops(
        onboarded_client,
        op("task_create", "c1", uid="u-1", list_id="nope", title="lost"),
        op("task_create", "c2", uid="u-2", list_id="work", title="kept"),
    )
    assert results[0]["status"] == "error"
    assert "nope" in results[0]["error"]
    assert results[1] == {"op_id": "c2", "status": "applied", "error": None}
    assert task_by_uid(sync(onboarded_client), "u-2")["title"] == "kept"


def test_create_without_title_errors(onboarded_client: TestClient) -> None:
    results = post_ops(onboarded_client, op("task_create", "c1", uid="u-1", list_id="work"))
    assert results[0]["status"] == "error"
    assert "title" in results[0]["error"]


# -- task_update -----------------------------------------------------------------


def test_update_applied(onboarded_client: TestClient) -> None:
    results = post_ops(
        onboarded_client,
        op(
            "task_update",
            "u1",
            uid=NC_SIMPLE_UID,
            list_id="work",
            title="Ring insurer NOW",
            priority=1,
        ),
    )
    assert results[0]["status"] == "applied"
    task = task_by_uid(sync(onboarded_client), NC_SIMPLE_UID)
    assert task["title"] == "Ring insurer NOW"
    assert task["priority"] == 1
    assert task["notes"] == ""  # untouched


def test_update_finds_task_without_list_hint(onboarded_client: TestClient) -> None:
    results = post_ops(
        onboarded_client, op("task_update", "u1", uid=NC_SIMPLE_UID, title="found you")
    )
    assert results[0]["status"] == "applied"


def test_update_finds_task_stored_under_foreign_filename(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    # Other clients may store objects under any filename — UID lookup must
    # fall back to a calendar-query when <uid>.ics misses.
    oddball = load_golden("nextcloud_simple.ics").replace(
        b"UID:nc-web-3f2a1b4c5d6e", b"UID:oddly-named-task"
    )
    fake_nc.put_ics(NC_USER, "work", "1D5C9A2E-legacy-apple-name.ics", oddball)
    results = post_ops(
        onboarded_client, op("task_update", "u1", uid="oddly-named-task", title="renamed")
    )
    assert results[0]["status"] == "applied"
    assert task_by_uid(sync(onboarded_client), "oddly-named-task")["title"] == "renamed"


def test_update_stale_etag_lww_reapplies(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    filename = f"{NC_SIMPLE_UID}.ics"

    def concurrent_notes_edit() -> None:
        current = fake_nc.get_object(NC_USER, "work", filename).ics
        fake_nc.put_ics(
            NC_USER,
            "work",
            filename,
            current.replace(b"STATUS:NEEDS-ACTION", b"STATUS:NEEDS-ACTION\r\nDESCRIPTION:racy"),
        )

    # Fires between the engine's GET and its If-Match PUT → guaranteed 412.
    fake_nc.add_after_get_hook(filename, concurrent_notes_edit)

    results = post_ops(
        onboarded_client, op("task_update", "u1", uid=NC_SIMPLE_UID, title="my title wins")
    )
    assert results[0]["status"] == "lww_reapplied"

    # Silent LWW: our field applied on top of the refetched copy — the
    # concurrent edit to a field we did not touch survives.
    task = task_by_uid(sync(onboarded_client), NC_SIMPLE_UID)
    assert task["title"] == "my title wins"
    assert task["notes"] == "racy"


def test_update_missing_task_errors(onboarded_client: TestClient) -> None:
    results = post_ops(onboarded_client, op("task_update", "u1", uid="ghost", title="x"))
    assert results[0]["status"] == "error"
    assert "not found" in results[0]["error"]


def test_update_with_no_fields_errors(onboarded_client: TestClient) -> None:
    results = post_ops(onboarded_client, op("task_update", "u1", uid=NC_SIMPLE_UID))
    assert results[0]["status"] == "error"


# -- task_complete / task_uncomplete ----------------------------------------------


def test_complete_non_recurring(onboarded_client: TestClient) -> None:
    results = post_ops(
        onboarded_client,
        op("task_complete", "d1", uid=NC_SIMPLE_UID, completed_at="2026-07-02T08:30:00+00:00"),
    )
    assert results[0]["status"] == "applied"
    task = task_by_uid(sync(onboarded_client), NC_SIMPLE_UID)
    assert task["completed"] is True
    assert task["completed_at"] == "2026-07-02T08:30:00+00:00"


def test_complete_recurring_rolls_forward(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    fake_nc.put_ics(NC_USER, "personal", f"{INFINITE_DAILY_UID}.ics", INFINITE_DAILY)
    results = post_ops(onboarded_client, op("task_complete", "d1", uid=INFINITE_DAILY_UID))
    assert results[0]["status"] == "applied"

    task = task_by_uid(sync(onboarded_client), INFINITE_DAILY_UID)
    assert task["completed"] is False  # roll-forward, not closure
    assert task["recurring"] is True
    assert task["due"] is not None
    assert datetime.fromisoformat(task["due"]) > datetime.now(UTC)


def test_complete_replay_does_not_double_roll(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    fake_nc.put_ics(NC_USER, "personal", f"{INFINITE_DAILY_UID}.ics", INFINITE_DAILY)
    complete = op("task_complete", "d1", uid=INFINITE_DAILY_UID)
    assert post_ops(onboarded_client, complete)[0]["status"] == "applied"
    due_after_first = task_by_uid(sync(onboarded_client), INFINITE_DAILY_UID)["due"]

    assert post_ops(onboarded_client, complete)[0]["status"] == "duplicate"
    assert task_by_uid(sync(onboarded_client), INFINITE_DAILY_UID)["due"] == due_after_first


def test_complete_invalid_completed_at_errors(onboarded_client: TestClient) -> None:
    results = post_ops(
        onboarded_client,
        op("task_complete", "d1", uid=NC_SIMPLE_UID, completed_at="yesterdayish"),
    )
    assert results[0]["status"] == "error"


def test_uncomplete_reopens(onboarded_client: TestClient) -> None:
    post_ops(onboarded_client, op("task_complete", "d1", uid=NC_SIMPLE_UID))
    results = post_ops(onboarded_client, op("task_uncomplete", "d2", uid=NC_SIMPLE_UID))
    assert results[0]["status"] == "applied"
    task = task_by_uid(sync(onboarded_client), NC_SIMPLE_UID)
    assert task["completed"] is False
    assert task["completed_at"] is None


# -- task_delete -----------------------------------------------------------------


def test_delete_applied_and_tombstoned(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    cursor = sync(onboarded_client)["cursor"]
    results = post_ops(onboarded_client, op("task_delete", "x1", uid=NC_SIMPLE_UID))
    assert results[0]["status"] == "applied"
    assert f"{NC_SIMPLE_UID}.ics" not in fake_nc.calendars[NC_USER]["work"].objects

    delta = sync(onboarded_client, cursor=cursor)
    assert task_by_uid(delta, NC_SIMPLE_UID)["deleted"] is True


def test_delete_missing_task_is_applied(onboarded_client: TestClient) -> None:
    # The end state (gone) is already true — deletion is idempotent by nature.
    results = post_ops(onboarded_client, op("task_delete", "x1", uid="ghost"))
    assert results[0]["status"] == "applied"


def test_delete_replay_is_duplicate(onboarded_client: TestClient) -> None:
    delete = op("task_delete", "x1", uid=NC_SIMPLE_UID)
    assert post_ops(onboarded_client, delete)[0]["status"] == "applied"
    assert post_ops(onboarded_client, delete)[0]["status"] == "duplicate"


# -- task_move -------------------------------------------------------------------


def test_move_preserves_uid_across_lists(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    results = post_ops(
        onboarded_client,
        op("task_move", "m1", uid=NC_SIMPLE_UID, list_id="work", to_list_id="personal"),
    )
    assert results[0]["status"] == "applied"

    task = task_by_uid(sync(onboarded_client), NC_SIMPLE_UID)  # exactly one copy
    assert task["list_id"] == "personal"
    assert task["title"] == "Ring insurer about policy renewal"  # body survived the move
    assert f"{NC_SIMPLE_UID}.ics" not in fake_nc.calendars[NC_USER]["work"].objects


def test_move_replay_is_duplicate_via_target_check(onboarded_client: TestClient) -> None:
    post_ops(
        onboarded_client,
        op("task_move", "m1", uid=NC_SIMPLE_UID, list_id="work", to_list_id="personal"),
    )
    # A different op_id replaying an already-finished move (journal lost).
    results = post_ops(
        onboarded_client,
        op("task_move", "m2", uid=NC_SIMPLE_UID, list_id="work", to_list_id="personal"),
    )
    assert results[0]["status"] == "duplicate"


def test_move_to_missing_list_errors(onboarded_client: TestClient) -> None:
    results = post_ops(
        onboarded_client, op("task_move", "m1", uid=NC_SIMPLE_UID, to_list_id="nope")
    )
    assert results[0]["status"] == "error"


def test_move_within_same_list_is_duplicate(onboarded_client: TestClient) -> None:
    results = post_ops(
        onboarded_client, op("task_move", "m1", uid=NC_SIMPLE_UID, to_list_id="work")
    )
    assert results[0]["status"] == "duplicate"


# -- list CRUD -------------------------------------------------------------------


def test_list_create_then_task_create_in_same_batch(onboarded_client: TestClient) -> None:
    # The classic offline drain: make a List, put a Task in it, one batch.
    results = post_ops(
        onboarded_client,
        op("list_create", "l1", list_id="garden", name="Garden"),
        op("task_create", "l2", uid="g-1", list_id="garden", title="Plant tomatoes"),
    )
    assert [r["status"] for r in results] == ["applied", "applied"]
    payload = sync(onboarded_client)
    assert ("garden", "Garden", False) in {
        (li["id"], li["name"], li["deleted"]) for li in payload["lists"]
    }
    assert task_by_uid(payload, "g-1")["list_id"] == "garden"


def test_list_create_replay_is_duplicate(onboarded_client: TestClient) -> None:
    post_ops(onboarded_client, op("list_create", "l1", list_id="garden", name="Garden"))
    results = post_ops(
        onboarded_client, op("list_create", "l2", list_id="garden", name="Garden")
    )
    assert results[0]["status"] == "duplicate"


def test_list_create_invalid_id_errors(onboarded_client: TestClient) -> None:
    results = post_ops(
        onboarded_client, op("list_create", "l1", list_id="../escape", name="X")
    )
    assert results[0]["status"] == "error"


def test_list_create_without_name_errors(onboarded_client: TestClient) -> None:
    results = post_ops(onboarded_client, op("list_create", "l1", list_id="garden"))
    assert results[0]["status"] == "error"


def test_list_rename(onboarded_client: TestClient) -> None:
    results = post_ops(
        onboarded_client, op("list_rename", "l1", list_id="work", name="Werk")
    )
    assert results[0]["status"] == "applied"
    assert ("work", "Werk") in {
        (li["id"], li["name"]) for li in sync(onboarded_client)["lists"]
    }


def test_list_rename_missing_errors(onboarded_client: TestClient) -> None:
    results = post_ops(onboarded_client, op("list_rename", "l1", list_id="nope", name="X"))
    assert results[0]["status"] == "error"


def test_list_delete_and_tombstone(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    cursor = sync(onboarded_client)["cursor"]
    results = post_ops(onboarded_client, op("list_delete", "l1", list_id="work"))
    assert results[0]["status"] == "applied"
    assert "work" not in fake_nc.calendars[NC_USER]

    delta = sync(onboarded_client, cursor=cursor)
    assert ("work", True) in {(li["id"], li["deleted"]) for li in delta["lists"]}


def test_list_delete_missing_is_applied(onboarded_client: TestClient) -> None:
    results = post_ops(onboarded_client, op("list_delete", "l1", list_id="nope"))
    assert results[0]["status"] == "applied"


# -- batch semantics ---------------------------------------------------------------


def test_empty_batch(onboarded_client: TestClient) -> None:
    assert post_ops(onboarded_client) == []


def test_unknown_kind_is_a_422(onboarded_client: TestClient) -> None:
    response = onboarded_client.post(
        "/api/ops",
        json={"ops": [{"op_id": "z1", "kind": "task_explode", "uid": "u"}]},
        headers=auth(),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_full_replay_of_mixed_batch_is_all_duplicates(onboarded_client: TestClient) -> None:
    batch = [
        op("list_create", "b1", list_id="garden", name="Garden"),
        op("task_create", "b2", uid="g-1", list_id="garden", title="Plant"),
        op("task_complete", "b3", uid="g-1"),
    ]
    first = post_ops(onboarded_client, *batch)
    assert [r["status"] for r in first] == ["applied", "applied", "applied"]
    replay = post_ops(onboarded_client, *batch)
    assert [r["status"] for r in replay] == ["duplicate", "duplicate", "duplicate"]
    # Effects happened exactly once.
    task = task_by_uid(sync(onboarded_client), "g-1")
    assert task["completed"] is True
