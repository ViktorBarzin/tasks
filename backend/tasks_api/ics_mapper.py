"""VTODO ↔ Task mapping (design doc: "Data mapping").

The one hard rule: **parse-modify-serialize, never template-regenerate.** Every
transform here parses the stored ICS with icalendar, touches only the
properties the Op names (plus SEQUENCE/DTSTAMP/LAST-MODIFIED bookkeeping) and
re-serializes — VALARM, RRULE, X-APPLE-*, CREATED and anything else Apple wrote
ride along untouched. Golden-file tests assert that byte-for-byte (unfolded).

| App field | ICS                                  |
|-----------|--------------------------------------|
| title     | SUMMARY                              |
| notes     | DESCRIPTION                          |
| due       | DUE (DATE or DATE-TIME)              |
| priority  | PRIORITY 0/9/5/1 (Apple mapping)     |
| completed | STATUS / COMPLETED / PERCENT-COMPLETE|
| uid       | UID                                  |
"""

from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Final, Literal

from icalendar import Calendar, Todo

from tasks_api import recurrence

PRIORITY_NONE: Final = 0
PRIORITY_HIGH: Final = 1
PRIORITY_MEDIUM: Final = 5
PRIORITY_LOW: Final = 9

PRODID = "-//viktorbarzin//tasks//EN"

#: Task fields an Op may set via task_create / task_update.
MUTABLE_FIELDS = frozenset({"title", "notes", "due", "due_has_time", "priority"})


class MapperError(Exception):
    """Raised when ICS content or Op field values cannot be mapped."""


@dataclass(frozen=True)
class ParsedTask:
    """The Task-JSON view of one VTODO (list_id/href attach at the sync layer)."""

    uid: str
    title: str
    notes: str
    due: str | None
    due_has_time: bool
    priority: Literal[0, 1, 5, 9]
    completed: bool
    completed_at: str | None
    recurring: bool


def _master_todo(cal: Calendar) -> Todo | None:
    """The master VTODO of an object: first component without a RECURRENCE-ID."""
    todos = [c for c in cal.walk("VTODO") if isinstance(c, Todo)]
    for todo in todos:
        if "RECURRENCE-ID" not in todo:
            return todo
    return todos[0] if todos else None


def _parse_calendar(ics: bytes) -> tuple[Calendar, Todo]:
    try:
        cal = Calendar.from_ical(ics)
    except ValueError as exc:
        raise MapperError(f"unparseable ICS: {exc}") from exc
    todo = _master_todo(cal)
    if todo is None:
        raise MapperError("object contains no VTODO")
    return cal, todo


def normalize_priority(raw: int) -> Literal[0, 1, 5, 9]:
    """RFC 5545 PRIORITY 0-9 → the app's four levels (Apple mapping)."""
    if 1 <= raw <= 4:
        return PRIORITY_HIGH
    if raw == 5:
        return PRIORITY_MEDIUM
    if 6 <= raw <= 9:
        return PRIORITY_LOW
    return PRIORITY_NONE


def _decode_due(todo: Todo) -> tuple[str | None, bool]:
    if "DUE" not in todo:
        return None, False
    value = todo.decoded("DUE")
    if isinstance(value, datetime):
        return value.isoformat(), True
    if isinstance(value, date):
        return value.isoformat(), False
    raise MapperError(f"unsupported DUE value: {value!r}")


def _decode_completed(todo: Todo) -> tuple[bool, str | None]:
    completed_at: str | None = None
    if "COMPLETED" in todo:
        stamp = todo.decoded("COMPLETED")
        if isinstance(stamp, datetime):
            completed_at = stamp.isoformat()
    status = str(todo.get("STATUS", "")).upper()
    completed = status == "COMPLETED" or completed_at is not None
    return completed, completed_at


def parse_task(ics: bytes) -> ParsedTask | None:
    """Map one CalDAV object to Task JSON; ``None`` when it holds no VTODO."""
    try:
        cal = Calendar.from_ical(ics)
    except ValueError as exc:
        raise MapperError(f"unparseable ICS: {exc}") from exc
    todo = _master_todo(cal)
    if todo is None:
        return None
    due, due_has_time = _decode_due(todo)
    completed, completed_at = _decode_completed(todo)
    return ParsedTask(
        uid=str(todo.get("UID", "")),
        title=str(todo.get("SUMMARY", "")),
        notes=str(todo.get("DESCRIPTION", "")),
        due=due,
        due_has_time=due_has_time,
        priority=normalize_priority(int(todo.get("PRIORITY", 0))),
        completed=completed,
        completed_at=completed_at,
        recurring="RRULE" in todo,
    )


def _due_string_has_time(due: str) -> bool:
    """Whether an ISO due string carries a time-of-day (``T``/space separator).

    A bare ISO date (``YYYY-MM-DD``) does not; a date-time does. Used to
    normalize a datetime ``due`` that arrived without ``due_has_time`` set.
    """
    return "T" in due or " " in due


def _parse_due_value(due: str, due_has_time: bool) -> date | datetime:
    """An Op's ISO due string → the ICS value (dates stay dates; aware → UTC)."""
    try:
        if due_has_time:
            value = datetime.fromisoformat(due)
            # Write aware datetimes as UTC: correct instant, no VTIMEZONE needed.
            return value.astimezone(UTC) if value.tzinfo is not None else value
        return date.fromisoformat(due)
    except ValueError as exc:
        raise MapperError(f"invalid due value {due!r}: {exc}") from exc


def _set_prop(todo: Todo, name: str, value: object) -> None:
    todo.pop(name, None)
    todo.add(name, value)


def _touch(todo: Todo, now: datetime) -> None:
    """Bookkeeping every rewrite performs: SEQUENCE bump + fresh stamps."""
    sequence = int(todo.get("SEQUENCE", 0))
    _set_prop(todo, "SEQUENCE", sequence + 1)
    _set_prop(todo, "DTSTAMP", now.astimezone(UTC))
    _set_prop(todo, "LAST-MODIFIED", now.astimezone(UTC))


def _apply_due(todo: Todo, due: str | None, due_has_time: bool) -> None:
    if due is None:
        # Clear the deadline; DTSTART (the RRULE anchor, when present) stays.
        todo.pop("DUE", None)
        return
    value = _parse_due_value(due, due_has_time)
    _set_prop(todo, "DUE", value)
    if "DTSTART" in todo:
        # Reminders-style tasks keep DTSTART == DUE; RFC 5545 requires
        # DTSTART <= DUE, so the anchor moves with the deadline.
        _set_prop(todo, "DTSTART", value)


def _apply_fields_to_todo(todo: Todo, fields: dict[str, object]) -> None:
    unknown = set(fields) - MUTABLE_FIELDS
    if unknown:
        raise MapperError(f"unknown task fields: {sorted(unknown)}")
    if "title" in fields:
        _set_prop(todo, "SUMMARY", str(fields["title"]))
    if "notes" in fields:
        notes = str(fields["notes"])
        if notes:
            _set_prop(todo, "DESCRIPTION", notes)
        else:
            todo.pop("DESCRIPTION", None)
    if "due" in fields or "due_has_time" in fields:
        due = fields.get("due")
        if due is not None and not isinstance(due, str):
            raise MapperError(f"invalid due value {due!r}: expected ISO string or null")
        has_time = bool(fields.get("due_has_time", False))
        # Guard inconsistent due fields (SYNC-12 / contract L): due and
        # due_has_time travel together. Reject a flag with no value (was:
        # silently clearing DUE); normalize a date-time value that arrived
        # without the flag (was: a confusing "invalid date" error).
        if due is None:
            if "due" not in fields:
                raise MapperError("due_has_time was sent without a due value; send both together")
            if has_time:
                raise MapperError("cannot clear due while due_has_time is true")
            _apply_due(todo, None, False)
        else:
            if not has_time and _due_string_has_time(due):
                has_time = True
            _apply_due(todo, due, has_time)
    if "priority" in fields:
        priority = fields["priority"]
        if (
            isinstance(priority, bool)
            or not isinstance(priority, int)
            or priority not in (PRIORITY_NONE, PRIORITY_HIGH, PRIORITY_MEDIUM, PRIORITY_LOW)
        ):
            raise MapperError(f"invalid priority {priority!r}: must be one of 0, 1, 5, 9")
        if priority == PRIORITY_NONE:
            todo.pop("PRIORITY", None)
        else:
            _set_prop(todo, "PRIORITY", priority)


def build_vtodo(uid: str, fields: dict[str, object], now: datetime) -> bytes:
    """A fresh VCALENDAR+VTODO for task_create (the only place we template)."""
    cal = Calendar()
    cal.add("VERSION", "2.0")
    cal.add("PRODID", PRODID)
    todo = Todo()
    todo.add("UID", uid)
    todo.add("SUMMARY", "")
    todo.add("CREATED", now.astimezone(UTC))
    todo.add("DTSTAMP", now.astimezone(UTC))
    todo.add("LAST-MODIFIED", now.astimezone(UTC))
    todo.add("STATUS", "NEEDS-ACTION")
    todo.add("SEQUENCE", 0)
    _apply_fields_to_todo(todo, fields)
    cal.add_component(todo)
    return cal.to_ical()


def apply_fields(ics: bytes, fields: dict[str, object], now: datetime) -> bytes:
    """task_update: set exactly the fields present in the Op, preserve the rest."""
    cal, todo = _parse_calendar(ics)
    _apply_fields_to_todo(todo, fields)
    _touch(todo, now)
    return cal.to_ical()


def apply_complete(ics: bytes, now: datetime, completed_at: datetime | None = None) -> bytes:
    """task_complete: Completion — or roll-forward for a Recurring Task.

    A live RRULE with a next occurrence advances DUE/DTSTART and leaves the
    task open (CONTEXT.md: "Completion means roll-forward, not closure");
    an exhausted rule (COUNT/UNTIL spent) completes normally.
    """
    cal, todo = _parse_calendar(ics)
    if not recurrence.roll_forward(todo, now):
        stamp = (completed_at or now).astimezone(UTC)
        _set_prop(todo, "STATUS", "COMPLETED")
        _set_prop(todo, "COMPLETED", stamp)
        _set_prop(todo, "PERCENT-COMPLETE", 100)
    _touch(todo, now)
    return cal.to_ical()


def apply_uncomplete(ics: bytes, now: datetime) -> bytes:
    """task_uncomplete: back to NEEDS-ACTION, completion stamps removed."""
    cal, todo = _parse_calendar(ics)
    _set_prop(todo, "STATUS", "NEEDS-ACTION")
    todo.pop("COMPLETED", None)
    todo.pop("PERCENT-COMPLETE", None)
    _touch(todo, now)
    return cal.to_ical()
