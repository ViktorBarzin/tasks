"""Golden-file round-trip fidelity + field mapping for the VTODO ↔ Task mapper.

The goldens are realistic Apple/Nextcloud VTODOs (curly quotes, folded lines,
escaped commas, VALARM/ACKNOWLEDGED, RRULE, X-APPLE-*). The core assertion:
after parse-modify-serialize, every property line the transform did not touch
survives **byte-identically** (compared unfolded, since RFC 5545 line folding
is presentation, not content).
"""

from datetime import UTC, datetime

import pytest

from tasks_api import ics_mapper
from tasks_api.ics_mapper import MapperError
from tests.conftest import load_golden, unfold_lines

NOW = datetime(2026, 7, 3, 12, 0, 0, tzinfo=UTC)

GOLDENS = [
    "apple_recurring_alarm.ics",
    "apple_allday_until.ics",
    "apple_daily_count.ics",
    "nextcloud_simple.ics",
]

# Properties every rewrite is allowed to touch (bookkeeping).
BOOKKEEPING = {"SEQUENCE", "DTSTAMP", "LAST-MODIFIED"}


def prop_name(line: bytes) -> str:
    head = line.split(b":", 1)[0].split(b";", 1)[0]
    return head.decode().upper()


def assert_untouched_preserved(original: bytes, modified: bytes, touched: set[str]) -> None:
    """Every property line whose name is not in ``touched`` must survive byte-for-byte."""
    allowed = {t.upper() for t in touched} | BOOKKEEPING
    new_lines = unfold_lines(modified)
    for line in unfold_lines(original):
        if prop_name(line) in allowed:
            continue
        assert line in new_lines, f"lost/altered property line: {line!r}"


@pytest.mark.parametrize("name", GOLDENS)
def test_pure_round_trip_preserves_every_line(name: str) -> None:
    """parse → serialize with no modification loses nothing (order aside)."""
    original = load_golden(name)
    from icalendar import Calendar

    out = Calendar.from_ical(original).to_ical()
    assert sorted(unfold_lines(original)) == sorted(unfold_lines(out))


def test_parse_apple_recurring_alarm() -> None:
    task = ics_mapper.parse_task(load_golden("apple_recurring_alarm.ics"))
    assert task is not None
    assert task.uid == "6FD37E05-9AF0-4C0B-A9E9-D3B0E0F1A2B3"
    # Curly quotes intact, escaped commas unescaped, folded line joined.
    assert task.title == (
        "Pay rent “flat 7”, water, electricity and a very long "
        "summary line that Apple folds at seventy-five octets exactly like this"
    )
    assert task.notes == ""
    assert task.due == "2026-07-01T09:00:00+03:00"
    assert task.due_has_time is True
    assert task.priority == 1
    assert task.completed is False
    assert task.completed_at is None
    assert task.recurring is True


def test_parse_apple_allday_until() -> None:
    task = ics_mapper.parse_task(load_golden("apple_allday_until.ics"))
    assert task is not None
    assert task.due == "2026-06-15"
    assert task.due_has_time is False
    assert task.priority == 5
    assert task.completed is True
    assert task.completed_at == "2026-06-15T19:15:00+00:00"
    assert task.recurring is True
    assert task.notes == "Take with food\nОт д-р Иванова, само зимата"


def test_parse_apple_daily_count() -> None:
    task = ics_mapper.parse_task(load_golden("apple_daily_count.ics"))
    assert task is not None
    assert task.due == "2026-07-01T05:45:00+00:00"
    assert task.due_has_time is True
    assert task.priority == 9
    assert task.recurring is True


def test_parse_nextcloud_simple() -> None:
    task = ics_mapper.parse_task(load_golden("nextcloud_simple.ics"))
    assert task is not None
    assert task.uid == "nc-web-3f2a1b4c5d6e"
    assert task.due is None
    assert task.due_has_time is False
    assert task.priority == 0
    assert task.completed is False
    assert task.recurring is False


def test_parse_non_vtodo_returns_none() -> None:
    ics = (
        b"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//EN\r\n"
        b"BEGIN:VEVENT\r\nUID:e1\r\nDTSTART:20260701T090000Z\r\nSUMMARY:party\r\n"
        b"END:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    assert ics_mapper.parse_task(ics) is None


def test_parse_garbage_raises() -> None:
    with pytest.raises(MapperError):
        ics_mapper.parse_task(b"not ics at all")


@pytest.mark.parametrize("name", GOLDENS)
def test_title_edit_preserves_all_other_properties(name: str) -> None:
    original = load_golden(name)
    modified = ics_mapper.apply_fields(original, {"title": "New title"}, NOW)
    assert_untouched_preserved(original, modified, touched={"SUMMARY"})
    assert b"SUMMARY:New title" in unfold_lines(modified)


def test_title_edit_bumps_sequence_and_stamps() -> None:
    original = load_golden("apple_recurring_alarm.ics")  # SEQUENCE:3
    modified = ics_mapper.apply_fields(original, {"title": "x"}, NOW)
    lines = unfold_lines(modified)
    assert b"SEQUENCE:4" in lines
    assert b"DTSTAMP:20260703T120000Z" in lines
    assert b"LAST-MODIFIED:20260703T120000Z" in lines


def test_title_with_specials_is_escaped_and_round_trips() -> None:
    original = load_golden("nextcloud_simple.ics")
    modified = ics_mapper.apply_fields(
        original, {"title": "Buy milk, eggs; call “Анка”"}, NOW
    )
    assert b"SUMMARY:Buy milk\\, eggs\\; call \xe2\x80\x9c\xd0\x90\xd0\xbd\xd0\xba\xd0\xb0\xe2\x80\x9d" in unfold_lines(modified)
    parsed = ics_mapper.parse_task(modified)
    assert parsed is not None
    assert parsed.title == "Buy milk, eggs; call “Анка”"


def test_due_edit_moves_dtstart_with_it_and_preserves_rrule() -> None:
    original = load_golden("apple_recurring_alarm.ics")
    modified = ics_mapper.apply_fields(
        original, {"due": "2026-07-08T10:30:00+03:00", "due_has_time": True}, NOW
    )
    lines = unfold_lines(modified)
    # Aware datetimes are written as UTC (07:30Z == 10:30+03:00).
    assert b"DUE:20260708T073000Z" in lines
    assert b"DTSTART:20260708T073000Z" in lines
    assert_untouched_preserved(original, modified, touched={"DUE", "DTSTART"})
    assert b"RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE" in lines


def test_due_all_day_edit() -> None:
    original = load_golden("apple_allday_until.ics")
    modified = ics_mapper.apply_fields(original, {"due": "2026-07-20"}, NOW)
    lines = unfold_lines(modified)
    assert b"DUE;VALUE=DATE:20260720" in lines
    assert b"DTSTART;VALUE=DATE:20260720" in lines
    assert_untouched_preserved(original, modified, touched={"DUE", "DTSTART"})


def test_due_clear_removes_due_keeps_rest() -> None:
    original = load_golden("apple_daily_count.ics")
    modified = ics_mapper.apply_fields(original, {"due": None}, NOW)
    lines = unfold_lines(modified)
    assert not any(line.startswith(b"DUE") for line in lines)
    assert_untouched_preserved(original, modified, touched={"DUE"})


def test_naive_due_stays_floating() -> None:
    original = load_golden("nextcloud_simple.ics")
    modified = ics_mapper.apply_fields(
        original, {"due": "2026-07-09T18:00:00", "due_has_time": True}, NOW
    )
    assert b"DUE:20260709T180000" in unfold_lines(modified)


def test_notes_set_and_clear() -> None:
    original = load_golden("nextcloud_simple.ics")
    with_notes = ics_mapper.apply_fields(original, {"notes": "line1\nline2, ok"}, NOW)
    assert b"DESCRIPTION:line1\\nline2\\, ok" in unfold_lines(with_notes)
    cleared = ics_mapper.apply_fields(with_notes, {"notes": ""}, NOW)
    assert not any(line.startswith(b"DESCRIPTION") for line in unfold_lines(cleared))


def test_priority_set_and_clear() -> None:
    original = load_golden("nextcloud_simple.ics")
    high = ics_mapper.apply_fields(original, {"priority": 1}, NOW)
    assert b"PRIORITY:1" in unfold_lines(high)
    cleared = ics_mapper.apply_fields(high, {"priority": 0}, NOW)
    assert not any(line.startswith(b"PRIORITY") for line in unfold_lines(cleared))


@pytest.mark.parametrize("bad", [{"priority": 3}, {"priority": "1"}, {"priority": True}])
def test_invalid_priority_rejected(bad: dict[str, object]) -> None:
    with pytest.raises(MapperError):
        ics_mapper.apply_fields(load_golden("nextcloud_simple.ics"), bad, NOW)


def test_invalid_due_rejected() -> None:
    with pytest.raises(MapperError):
        ics_mapper.apply_fields(
            load_golden("nextcloud_simple.ics"),
            {"due": "not-a-date", "due_has_time": True},
            NOW,
        )


def test_unknown_field_rejected() -> None:
    with pytest.raises(MapperError):
        ics_mapper.apply_fields(load_golden("nextcloud_simple.ics"), {"color": "red"}, NOW)


def test_complete_non_recurring() -> None:
    original = load_golden("nextcloud_simple.ics")
    done = ics_mapper.apply_complete(original, NOW)
    lines = unfold_lines(done)
    assert b"STATUS:COMPLETED" in lines
    assert b"COMPLETED:20260703T120000Z" in lines
    assert b"PERCENT-COMPLETE:100" in lines
    assert_untouched_preserved(
        original, done, touched={"STATUS", "COMPLETED", "PERCENT-COMPLETE"}
    )
    parsed = ics_mapper.parse_task(done)
    assert parsed is not None
    assert parsed.completed is True
    assert parsed.completed_at == "2026-07-03T12:00:00+00:00"


def test_complete_honors_client_completed_at() -> None:
    done = ics_mapper.apply_complete(
        load_golden("nextcloud_simple.ics"),
        NOW,
        completed_at=datetime(2026, 7, 2, 8, 30, tzinfo=UTC),
    )
    assert b"COMPLETED:20260702T083000Z" in unfold_lines(done)


def test_complete_recurring_rolls_forward_and_preserves_alarm() -> None:
    original = load_golden("apple_daily_count.ics")  # DUE 2026-07-01T05:45Z, COUNT=10
    rolled = ics_mapper.apply_complete(original, NOW)  # NOW = 2026-07-03 12:00Z
    lines = unfold_lines(rolled)
    # Next occurrence strictly after now: 2026-07-04T05:45Z; 3 consumed (1st..3rd).
    assert b"DUE:20260704T054500Z" in lines
    assert b"RRULE:FREQ=DAILY;COUNT=7" in lines
    assert b"STATUS:NEEDS-ACTION" in lines
    assert not any(line.startswith(b"COMPLETED:") for line in lines)
    # The VALARM block and X-props are untouched.
    assert_untouched_preserved(original, rolled, touched={"DUE", "RRULE"})
    parsed = ics_mapper.parse_task(rolled)
    assert parsed is not None
    assert parsed.completed is False
    assert parsed.recurring is True


def test_complete_recurring_exhausted_completes_normally() -> None:
    original = load_golden("apple_daily_count.ics")  # 10 daily occurrences from 07-01
    after_the_end = datetime(2026, 8, 1, 0, 0, tzinfo=UTC)
    done = ics_mapper.apply_complete(original, after_the_end)
    lines = unfold_lines(done)
    assert b"STATUS:COMPLETED" in lines
    assert b"PERCENT-COMPLETE:100" in lines
    assert b"DUE:20260701T054500Z" in lines  # unchanged
    assert b"RRULE:FREQ=DAILY;COUNT=10" in lines  # rule preserved verbatim


def test_uncomplete() -> None:
    original = load_golden("apple_allday_until.ics")
    reopened = ics_mapper.apply_uncomplete(original, NOW)
    lines = unfold_lines(reopened)
    assert b"STATUS:NEEDS-ACTION" in lines
    assert not any(line.startswith(b"COMPLETED:") for line in lines)
    assert not any(line.startswith(b"PERCENT-COMPLETE") for line in lines)
    assert_untouched_preserved(
        original, reopened, touched={"STATUS", "COMPLETED", "PERCENT-COMPLETE"}
    )


def test_build_vtodo_round_trips() -> None:
    ics = ics_mapper.build_vtodo(
        "new-uid-1",
        {
            "title": "Fresh task",
            "notes": "some notes",
            "due": "2026-07-10T09:00:00+03:00",
            "due_has_time": True,
            "priority": 5,
        },
        NOW,
    )
    lines = unfold_lines(ics)
    assert b"BEGIN:VCALENDAR" in lines and b"VERSION:2.0" in lines
    parsed = ics_mapper.parse_task(ics)
    assert parsed is not None
    assert parsed.uid == "new-uid-1"
    assert parsed.title == "Fresh task"
    assert parsed.notes == "some notes"
    assert parsed.due == "2026-07-10T06:00:00+00:00"  # normalized to UTC
    assert parsed.due_has_time is True
    assert parsed.priority == 5
    assert parsed.completed is False


def test_build_vtodo_all_day() -> None:
    ics = ics_mapper.build_vtodo(
        "new-uid-2", {"title": "All day", "due": "2026-07-11", "due_has_time": False}, NOW
    )
    assert b"DUE;VALUE=DATE:20260711" in unfold_lines(ics)
    parsed = ics_mapper.parse_task(ics)
    assert parsed is not None
    assert parsed.due == "2026-07-11"
    assert parsed.due_has_time is False
