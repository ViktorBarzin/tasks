"""POST /api/ops — the replay contract (ADR-0001), against FakeNextcloud.

The three guarantees under test: idempotent replay (op_id journal + create-UID
existence ⇒ ``duplicate``, never a double-apply), Silent LWW (stale ETag 412 ⇒
refetch + re-apply ⇒ ``lww_reapplied``), and per-Op isolation (one bad Op
errors, the rest of the batch still applies, results stay ordered).
"""

from collections.abc import Callable, Iterator
from datetime import UTC, datetime

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import AsyncSession

from tasks_api.app import create_app
from tasks_api.routers import ops as ops_module
from tests.conftest import NC_PASS, NC_USER, auth, load_golden, unfold_lines
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


def test_create_carries_sort_order(onboarded_client: TestClient) -> None:
    # Quick-add appends at max+1024 client-side; the create op carries the key
    # like any other field (contract delta v1.3 §2/§4).
    results = post_ops(
        onboarded_client,
        op("task_create", "c1", uid="ordered-1", list_id="work", title="Last", sort_order=5120),
    )
    assert results == [{"op_id": "c1", "status": "applied", "error": None}]
    assert task_by_uid(sync(onboarded_client), "ordered-1")["sort_order"] == 5120


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


# -- creation field fidelity (contract delta v1.2 §3: quick-add priority + sheet) --


@pytest.mark.parametrize("priority", [0, 1, 5, 9])
def test_create_honors_each_priority_level(onboarded_client: TestClient, priority: int) -> None:
    post_ops(
        onboarded_client,
        op("task_create", "c1", uid="prio-task", list_id="work", title="P", priority=priority),
    )
    assert task_by_uid(sync(onboarded_client), "prio-task")["priority"] == priority


def test_create_priority_none_writes_no_priority_prop(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    post_ops(
        onboarded_client,
        op("task_create", "c1", uid="p0", list_id="work", title="No prio", priority=0),
    )
    lines = unfold_lines(fake_nc.get_object(NC_USER, "work", "p0.ics").ics)
    assert not any(line.startswith(b"PRIORITY") for line in lines)


def test_create_invalid_priority_errors(onboarded_client: TestClient) -> None:
    results = post_ops(
        onboarded_client,
        op("task_create", "c1", uid="bad-prio", list_id="work", title="x", priority=3),
    )
    assert results[0]["status"] == "error"
    assert "priority" in results[0]["error"]


def test_create_honors_notes_and_allday_due(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    # The expanded quick-add sheet sends the full field set in one task_create.
    post_ops(
        onboarded_client,
        op(
            "task_create",
            "c1",
            uid="full-create",
            list_id="work",
            title="Water plants",
            notes="the balcony ones\nand the ficus",
            due="2026-07-12",
            due_has_time=False,
            priority=9,
        ),
    )
    task = task_by_uid(sync(onboarded_client), "full-create")
    assert task["notes"] == "the balcony ones\nand the ficus"
    assert task["due"] == "2026-07-12"
    assert task["due_has_time"] is False
    assert task["priority"] == 9
    # A real DATE value on the wire, not a midnight DATE-TIME.
    lines = unfold_lines(fake_nc.get_object(NC_USER, "work", "full-create.ics").ics)
    assert b"DUE;VALUE=DATE:20260712" in lines


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


def test_update_sets_sort_order(onboarded_client: TestClient) -> None:
    # Reordering rides task_update — no new op kind (contract delta v1.3 §2).
    results = post_ops(
        onboarded_client, op("task_update", "u1", uid=NC_SIMPLE_UID, sort_order=3584)
    )
    assert results[0]["status"] == "applied"
    task = task_by_uid(sync(onboarded_client), NC_SIMPLE_UID)
    assert task["sort_order"] == 3584
    assert task["title"] == "Ring insurer about policy renewal"  # untouched


def test_update_clears_sort_order_with_null(onboarded_client: TestClient) -> None:
    post_ops(onboarded_client, op("task_update", "u1", uid=NC_SIMPLE_UID, sort_order=99))
    results = post_ops(
        onboarded_client, op("task_update", "u2", uid=NC_SIMPLE_UID, sort_order=None)
    )
    assert results[0]["status"] == "applied"
    assert task_by_uid(sync(onboarded_client), NC_SIMPLE_UID)["sort_order"] is None


def test_update_invalid_sort_order_errors_batch_continues(
    onboarded_client: TestClient,
) -> None:
    results = post_ops(
        onboarded_client,
        op("task_update", "u1", uid=NC_SIMPLE_UID, sort_order=True),
        op("task_update", "u2", uid=NC_SIMPLE_UID, sort_order=2048),
    )
    assert [r["status"] for r in results] == ["error", "applied"]
    assert task_by_uid(sync(onboarded_client), NC_SIMPLE_UID)["sort_order"] == 2048


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


def test_complete_recurring_occurrence_due_match_rolls_from_completed_at(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    fake_nc.put_ics(NC_USER, "personal", f"{INFINITE_DAILY_UID}.ics", INFINITE_DAILY)
    results = post_ops(
        onboarded_client,
        op(
            "task_complete",
            "d1",
            uid=INFINITE_DAILY_UID,
            completed_at="2026-07-01T06:00:00+00:00",
            occurrence_due="2026-07-01T05:45:00+00:00",  # == the object's current DUE
        ),
    )
    assert results[0]["status"] == "applied"
    task = task_by_uid(sync(onboarded_client), INFINITE_DAILY_UID)
    assert task["completed"] is False  # rolled, not closed
    # Next occurrence after the completion instant (06:00), not replay-now.
    assert task["due"] == "2026-07-02T05:45:00+00:00"


def test_complete_recurring_occurrence_due_mismatch_is_duplicate(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    # The object already advanced past the occurrence the client saw (completed
    # elsewhere) — a stale occurrence_due must NOT trigger a second roll (C).
    fake_nc.put_ics(NC_USER, "personal", f"{INFINITE_DAILY_UID}.ics", INFINITE_DAILY)
    results = post_ops(
        onboarded_client,
        op(
            "task_complete",
            "d1",
            uid=INFINITE_DAILY_UID,
            completed_at="2026-07-01T06:00:00+00:00",
            occurrence_due="2026-06-30T05:45:00+00:00",  # != current DUE (2026-07-01)
        ),
    )
    assert results[0]["status"] == "duplicate"
    # DUE untouched — no second roll.
    assert task_by_uid(sync(onboarded_client), INFINITE_DAILY_UID)["due"] == (
        "2026-07-01T05:45:00+00:00"
    )


def test_complete_journal_race_is_duplicate_not_a_crash(
    onboarded_client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Crash-safety (C): if the pre-SELECT misses a row another request already
    # journaled (the check-then-act window), the atomic insert hits the unique
    # op_id, raises IntegrityError, and must resolve to duplicate — never a 500.
    complete = op("task_complete", "d1", uid=NC_SIMPLE_UID)
    assert post_ops(onboarded_client, complete)[0]["status"] == "applied"  # row now exists

    async def blind_precheck(
        session: AsyncSession, username: str, op_ids: list[str]
    ) -> set[str]:
        return set()  # pretend the pre-check saw nothing

    monkeypatch.setattr(ops_module, "_journaled_op_ids", blind_precheck)
    results = post_ops(onboarded_client, complete)
    assert results[0]["status"] == "duplicate"


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


def test_move_locates_in_source_first_not_a_target_shadow(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    # A half-finished earlier move left a copy in the target while the original
    # still lives in the source. The op carries list_id (SOURCE) + to_list_id
    # (DEST); the backend must locate in the source first and finish the move —
    # NOT see the target shadow and wrongly report a no-op, stranding the source.
    shadow = load_golden("nextcloud_simple.ics")
    fake_nc.put_ics(NC_USER, "personal", f"{NC_SIMPLE_UID}.ics", shadow)  # target shadow

    results = post_ops(
        onboarded_client,
        op("task_move", "m1", uid=NC_SIMPLE_UID, list_id="work", to_list_id="personal"),
    )
    assert results[0]["status"] == "applied"
    # The source copy is gone; exactly one copy remains, in the target.
    assert f"{NC_SIMPLE_UID}.ics" not in fake_nc.calendars[NC_USER]["work"].objects
    assert task_by_uid(sync(onboarded_client), NC_SIMPLE_UID)["list_id"] == "personal"


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


# -- list_reorder (contract delta v1.2 §2) -----------------------------------------


def test_list_reorder_applied_and_visible_in_sync(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    results = post_ops(onboarded_client, op("list_reorder", "r1", list_id="work", order=0))
    assert results == [{"op_id": "r1", "status": "applied", "error": None}]
    # PROPPATCHed calendar-order on the collection itself.
    assert fake_nc.calendars[NC_USER]["work"].order == 0
    assert ("PROPPATCH", "/remote.php/dav/calendars/viktor-nc/work/") in fake_nc.requests
    lists = {li["id"]: li for li in sync(onboarded_client)["lists"]}
    assert lists["work"]["order"] == 0
    assert lists["personal"]["order"] is None  # untouched Lists stay unordered


def test_list_reorder_batch_orders_multiple_lists(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    # The client emits one op per changed List; they ride in one batch.
    results = post_ops(
        onboarded_client,
        op("list_reorder", "r1", list_id="personal", order=1),
        op("list_reorder", "r2", list_id="work", order=0),
    )
    assert [r["status"] for r in results] == ["applied", "applied"]
    assert fake_nc.calendars[NC_USER]["personal"].order == 1
    assert fake_nc.calendars[NC_USER]["work"].order == 0


def test_list_reorder_replay_is_duplicate(onboarded_client: TestClient) -> None:
    reorder = op("list_reorder", "r1", list_id="work", order=3)
    assert post_ops(onboarded_client, reorder)[0]["status"] == "applied"
    assert post_ops(onboarded_client, reorder)[0]["status"] == "duplicate"


def test_list_reorder_same_value_new_op_id_is_a_noop_apply(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    # Idempotent by nature: re-setting the same order (journal lost) is a no-op.
    post_ops(onboarded_client, op("list_reorder", "r1", list_id="work", order=2))
    results = post_ops(onboarded_client, op("list_reorder", "r2", list_id="work", order=2))
    assert results[0]["status"] == "applied"
    assert fake_nc.calendars[NC_USER]["work"].order == 2


def test_list_reorder_missing_list_errors(onboarded_client: TestClient) -> None:
    results = post_ops(onboarded_client, op("list_reorder", "r1", list_id="nope", order=1))
    assert results[0]["status"] == "error"
    assert "nope" in results[0]["error"]


@pytest.mark.parametrize("bad_order", [None, "first", 1.5, True])
def test_list_reorder_invalid_order_errors(
    onboarded_client: TestClient, bad_order: object
) -> None:
    results = post_ops(
        onboarded_client, op("list_reorder", "r1", list_id="work", order=bad_order)
    )
    assert results[0]["status"] == "error"
    assert "order" in results[0]["error"]


def test_list_reorder_without_order_errors(onboarded_client: TestClient) -> None:
    results = post_ops(onboarded_client, op("list_reorder", "r1", list_id="work"))
    assert results[0]["status"] == "error"
    assert "order" in results[0]["error"]


# -- list_set_sort_mode (contract delta v1.4 §2) -------------------------------------


@pytest.mark.parametrize("mode", ["custom", "priority", "due"])
def test_list_set_sort_mode_applied_and_visible_in_sync(
    onboarded_client: TestClient, fake_nc: FakeNextcloud, mode: str
) -> None:
    results = post_ops(
        onboarded_client, op("list_set_sort_mode", "m1", list_id="work", sort_mode=mode)
    )
    assert results == [{"op_id": "m1", "status": "applied", "error": None}]
    # PROPPATCHed the custom dead property on the collection itself.
    assert fake_nc.calendars[NC_USER]["work"].sort_mode == mode
    assert ("PROPPATCH", "/remote.php/dav/calendars/viktor-nc/work/") in fake_nc.requests
    lists = {li["id"]: li for li in sync(onboarded_client)["lists"]}
    assert lists["work"]["sort_mode"] == mode
    assert lists["personal"]["sort_mode"] is None  # untouched Lists stay unset


def test_list_set_sort_mode_replay_is_duplicate(onboarded_client: TestClient) -> None:
    set_mode = op("list_set_sort_mode", "m1", list_id="work", sort_mode="due")
    assert post_ops(onboarded_client, set_mode)[0]["status"] == "applied"
    assert post_ops(onboarded_client, set_mode)[0]["status"] == "duplicate"


def test_list_set_sort_mode_same_value_new_op_id_is_a_noop_apply(
    onboarded_client: TestClient, fake_nc: FakeNextcloud
) -> None:
    # Idempotent by nature: re-setting the same mode (journal lost) is a no-op.
    post_ops(onboarded_client, op("list_set_sort_mode", "m1", list_id="work", sort_mode="due"))
    results = post_ops(
        onboarded_client, op("list_set_sort_mode", "m2", list_id="work", sort_mode="due")
    )
    assert results[0]["status"] == "applied"
    assert fake_nc.calendars[NC_USER]["work"].sort_mode == "due"


def test_list_set_sort_mode_missing_list_errors(onboarded_client: TestClient) -> None:
    results = post_ops(
        onboarded_client, op("list_set_sort_mode", "m1", list_id="nope", sort_mode="due")
    )
    assert results[0]["status"] == "error"
    assert "nope" in results[0]["error"]


@pytest.mark.parametrize("bad_mode", [None, 42, True, "alphabetical", "", "Priority"])
def test_list_set_sort_mode_invalid_value_errors_batch_continues(
    onboarded_client: TestClient, fake_nc: FakeNextcloud, bad_mode: object
) -> None:
    # Contract v1.4 §2: an invalid value is a per-op error; the batch continues.
    results = post_ops(
        onboarded_client,
        op("list_set_sort_mode", "m1", list_id="work", sort_mode=bad_mode),
        op("list_set_sort_mode", "m2", list_id="work", sort_mode="priority"),
    )
    assert [r["status"] for r in results] == ["error", "applied"]
    assert "sort_mode" in results[0]["error"]
    assert fake_nc.calendars[NC_USER]["work"].sort_mode == "priority"


def test_list_set_sort_mode_without_value_errors(onboarded_client: TestClient) -> None:
    results = post_ops(onboarded_client, op("list_set_sort_mode", "m1", list_id="work"))
    assert results[0]["status"] == "error"
    assert "sort_mode" in results[0]["error"]


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


def test_unknown_kind_is_a_per_op_error_not_a_batch_422(onboarded_client: TestClient) -> None:
    # Contract B: one unsupported/malformed op must NOT hard-422 the whole
    # batch — it becomes a per-op ``error`` and the valid ops still apply.
    response = onboarded_client.post(
        "/api/ops",
        json={
            "ops": [
                {"op_id": "z1", "kind": "task_explode", "uid": "u"},
                op("task_create", "z2", uid="keep-1", list_id="work", title="kept"),
            ]
        },
        headers=auth(),
    )
    assert response.status_code == 200, response.text
    results = response.json()["results"]
    assert results[0] == {"op_id": "z1", "status": "error", "error": results[0]["error"]}
    assert results[0]["error"] and "task_explode" in results[0]["error"]
    assert results[1]["status"] == "applied"
    assert task_by_uid(sync(onboarded_client), "keep-1")["title"] == "kept"


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


# -- retry vs error taxonomy + ordering (contract B / SYNC-3, PWA-F2) ------------


def _client_through(
    app_env: str, handler: Callable[[httpx.Request], httpx.Response]
) -> Iterator[TestClient]:
    app = create_app(caldav_transport=httpx.MockTransport(handler))
    with TestClient(app) as client:
        onboard = client.post(
            "/api/onboard",
            json={"nc_username": NC_USER, "app_password": NC_PASS},
            headers=auth(),
        )
        assert onboard.status_code == 204, onboard.text
        yield client


def _raw_ops(client: TestClient, *ops: dict) -> httpx.Response:
    return client.post("/api/ops", json={"ops": list(ops)}, headers=auth())


def test_transient_5xx_stops_batch_at_retry_and_omits_remainder(
    app_env: str, fake_nc: FakeNextcloud
) -> None:
    def flaky(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT" and "/personal/" in request.url.path:
            return httpx.Response(503)  # Nextcloud transient
        return fake_nc.handler(request)

    client = next(_client_through(app_env, flaky))
    response = _raw_ops(
        client,
        op("task_create", "b1", uid="ok-before", list_id="work", title="before"),
        op("task_create", "b2", uid="stuck", list_id="personal", title="stuck"),
        op("task_create", "b3", uid="never-tried", list_id="work", title="after"),
    )
    assert response.status_code == 200, response.text
    results = response.json()["results"]
    # Processed prefix + the stopper as retry; the unattempted remainder omitted.
    assert [(r["op_id"], r["status"]) for r in results] == [("b1", "applied"), ("b2", "retry")]
    # b1 landed; b2 (transient) and b3 (never attempted) did not.
    assert "ok-before.ics" in fake_nc.calendars[NC_USER]["work"].objects
    assert "never-tried.ics" not in fake_nc.calendars[NC_USER]["work"].objects


def test_retry_is_not_journaled_so_a_resend_still_applies(
    app_env: str, fake_nc: FakeNextcloud
) -> None:
    failures = {"n": 1}

    def flaky_once(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT" and "/personal/" in request.url.path and failures["n"]:
            failures["n"] -= 1
            return httpx.Response(502)
        return fake_nc.handler(request)

    client = next(_client_through(app_env, flaky_once))
    first = _raw_ops(client, op("task_create", "r1", uid="retry-me", list_id="personal", title="x"))
    assert [r["status"] for r in first.json()["results"]] == ["retry"]
    # Same op_id resent next cycle: the transient failure cleared, so it applies
    # (a retry never poisons the journal).
    second = _raw_ops(client, op("task_create", "r1", uid="retry-me", list_id="personal", title="x"))
    assert [r["status"] for r in second.json()["results"]] == ["applied"]


def test_upstream_timeout_maps_to_retry(app_env: str, fake_nc: FakeNextcloud) -> None:
    def timing_out(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT" and "/personal/" in request.url.path:
            raise httpx.ConnectTimeout("simulated upstream timeout")
        return fake_nc.handler(request)

    client = next(_client_through(app_env, timing_out))
    response = _raw_ops(client, op("task_create", "t1", uid="timed", list_id="personal", title="x"))
    assert [r["status"] for r in response.json()["results"]] == ["retry"]


def test_permanent_4xx_is_isolated_as_error_batch_continues(
    app_env: str, fake_nc: FakeNextcloud
) -> None:
    def forbidden(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT" and "/personal/" in request.url.path:
            return httpx.Response(403)  # permanent — never succeeds as-is
        return fake_nc.handler(request)

    client = next(_client_through(app_env, forbidden))
    response = _raw_ops(
        client,
        op("task_create", "e1", uid="doomed", list_id="personal", title="no"),
        op("task_create", "e2", uid="fine", list_id="work", title="yes"),
    )
    results = response.json()["results"]
    # 4xx → error (isolated, skip), NOT retry — so the batch keeps going.
    assert [(r["op_id"], r["status"]) for r in results] == [("e1", "error"), ("e2", "applied")]
    assert "fine.ics" in fake_nc.calendars[NC_USER]["work"].objects
