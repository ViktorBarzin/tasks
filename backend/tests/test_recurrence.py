"""Completion roll-forward (design decision #8): DUE/DTSTART advance to the
next occurrence strictly after now; COUNT/UNTIL exhaustion means normal
completion. Covers daily/weekly/monthly, all-day vs timed, timezones (incl. a
DST crossing and Apple's UTC-UNTIL-on-all-day quirk), and a hypothesis
property pinning COUNT bookkeeping to a dateutil oracle.
"""

from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from dateutil.rrule import rrulestr
from hypothesis import given, settings
from hypothesis import strategies as st
from icalendar import Calendar, Todo
from icalendar.prop import vRecur

from tasks_api import recurrence

SOFIA = ZoneInfo("Europe/Sofia")


def parse_vtodo(*props: str) -> Todo:
    ics = (
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n"
        "BEGIN:VTODO\r\nUID:t-1\r\nSUMMARY:t\r\n"
        + "".join(f"{p}\r\n" for p in props)
        + "END:VTODO\r\nEND:VCALENDAR\r\n"
    )
    cal = Calendar.from_ical(ics)
    todo = next(c for c in cal.walk("VTODO") if isinstance(c, Todo))
    return todo


def rule_text(todo: Todo) -> str:
    return todo["RRULE"].to_ical().decode()


# -- daily / weekly / monthly ------------------------------------------------


def test_daily_timed_rolls_to_next_after_now() -> None:
    todo = parse_vtodo("DUE:20260701T054500Z", "RRULE:FREQ=DAILY")
    now = datetime(2026, 7, 3, 12, 0, tzinfo=UTC)
    assert recurrence.roll_forward(todo, now) is True
    assert todo.decoded("DUE") == datetime(2026, 7, 4, 5, 45, tzinfo=UTC)
    assert rule_text(todo) == "FREQ=DAILY"


def test_weekly_interval_byday() -> None:
    # Anchored Wed 2026-07-01; every 2 weeks on Mo/We.
    todo = parse_vtodo("DUE:20260701T090000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE")
    now = datetime(2026, 7, 1, 9, 30, tzinfo=UTC)  # just after the anchor
    assert recurrence.roll_forward(todo, now) is True
    # Next in the 2-weekly MO/WE sequence: Mon 2026-07-13.
    assert todo.decoded("DUE") == datetime(2026, 7, 13, 9, 0, tzinfo=UTC)
    assert rule_text(todo) == "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"


def test_monthly_allday_stays_a_date() -> None:
    todo = parse_vtodo(
        "DTSTART;VALUE=DATE:20260615",
        "DUE;VALUE=DATE:20260615",
        "RRULE:FREQ=MONTHLY;BYMONTHDAY=15",
    )
    now = datetime(2026, 7, 3, 12, 0, tzinfo=UTC)
    assert recurrence.roll_forward(todo, now) is True
    assert todo.decoded("DUE") == date(2026, 7, 15)
    assert todo.decoded("DTSTART") == date(2026, 7, 15)
    # Still an all-day task: DATE, not DATE-TIME.
    assert b"DUE;VALUE=DATE:20260715" in todo.to_ical()


def test_overdue_skips_all_missed_occurrences() -> None:
    todo = parse_vtodo("DUE:20260101T080000Z", "RRULE:FREQ=DAILY")
    now = datetime(2026, 7, 3, 7, 59, tzinfo=UTC)  # half a year overdue
    assert recurrence.roll_forward(todo, now) is True
    assert todo.decoded("DUE") == datetime(2026, 7, 3, 8, 0, tzinfo=UTC)


def test_early_completion_still_advances_past_current_due() -> None:
    # Completing days before the deadline must not re-land on the same DUE.
    todo = parse_vtodo("DUE:20260710T080000Z", "RRULE:FREQ=WEEKLY")
    now = datetime(2026, 7, 3, 12, 0, tzinfo=UTC)  # a week early
    assert recurrence.roll_forward(todo, now) is True
    assert todo.decoded("DUE") == datetime(2026, 7, 17, 8, 0, tzinfo=UTC)


# -- COUNT bookkeeping ---------------------------------------------------------


def test_count_decrements_by_consumed_occurrences() -> None:
    todo = parse_vtodo("DUE:20260701T054500Z", "RRULE:FREQ=DAILY;COUNT=10")
    now = datetime(2026, 7, 3, 12, 0, tzinfo=UTC)  # 07-01..07-03 consumed
    assert recurrence.roll_forward(todo, now) is True
    assert todo.decoded("DUE") == datetime(2026, 7, 4, 5, 45, tzinfo=UTC)
    assert rule_text(todo) == "FREQ=DAILY;COUNT=7"


def test_count_on_time_completion_consumes_exactly_one() -> None:
    todo = parse_vtodo("DUE:20260701T054500Z", "RRULE:FREQ=DAILY;COUNT=10")
    now = datetime(2026, 7, 1, 6, 0, tzinfo=UTC)
    assert recurrence.roll_forward(todo, now) is True
    assert todo.decoded("DUE") == datetime(2026, 7, 2, 5, 45, tzinfo=UTC)
    assert rule_text(todo) == "FREQ=DAILY;COUNT=9"


def test_count_exhausted_means_normal_completion() -> None:
    todo = parse_vtodo("DUE:20260701T054500Z", "RRULE:FREQ=DAILY;COUNT=3")
    now = datetime(2026, 8, 1, 0, 0, tzinfo=UTC)  # past all 3 occurrences
    assert recurrence.roll_forward(todo, now) is False
    assert todo.decoded("DUE") == datetime(2026, 7, 1, 5, 45, tzinfo=UTC)  # untouched
    assert rule_text(todo) == "FREQ=DAILY;COUNT=3"  # preserved verbatim


def test_count_last_remaining_occurrence_rolls_to_it() -> None:
    todo = parse_vtodo("DUE:20260701T054500Z", "RRULE:FREQ=DAILY;COUNT=3")
    now = datetime(2026, 7, 2, 12, 0, tzinfo=UTC)  # only 07-03 remains
    assert recurrence.roll_forward(todo, now) is True
    assert todo.decoded("DUE") == datetime(2026, 7, 3, 5, 45, tzinfo=UTC)
    assert rule_text(todo) == "FREQ=DAILY;COUNT=1"


# -- UNTIL ---------------------------------------------------------------------


def test_until_exhausted_means_normal_completion() -> None:
    todo = parse_vtodo(
        "DUE;VALUE=DATE:20260615",
        "RRULE:FREQ=MONTHLY;UNTIL=20261231T215959Z;BYMONTHDAY=15",
    )
    now = datetime(2027, 1, 10, 0, 0, tzinfo=UTC)
    assert recurrence.roll_forward(todo, now) is False


def test_apple_utc_until_on_allday_task() -> None:
    # Apple writes UNTIL as a UTC date-time even when DUE is a bare DATE;
    # the naive/aware mismatch must not crash dateutil.
    todo = parse_vtodo(
        "DTSTART;VALUE=DATE:20260615",
        "DUE;VALUE=DATE:20260615",
        "RRULE:FREQ=MONTHLY;UNTIL=20261231T215959Z;BYMONTHDAY=15",
    )
    now = datetime(2026, 11, 20, 12, 0, tzinfo=UTC)
    assert recurrence.roll_forward(todo, now) is True
    assert todo.decoded("DUE") == date(2026, 12, 15)
    # UNTIL preserved verbatim, still UTC date-time form.
    assert "UNTIL=20261231T215959Z" in rule_text(todo)


def test_until_on_timed_aware_task() -> None:
    todo = parse_vtodo("DUE:20260701T090000Z", "RRULE:FREQ=WEEKLY;UNTIL=20260715T090000Z")
    now = datetime(2026, 7, 2, 0, 0, tzinfo=UTC)
    assert recurrence.roll_forward(todo, now) is True
    assert todo.decoded("DUE") == datetime(2026, 7, 8, 9, 0, tzinfo=UTC)
    # One occurrence left (07-15); after it the rule is exhausted.
    now = datetime(2026, 7, 20, 0, 0, tzinfo=UTC)
    assert recurrence.roll_forward(todo, now) is False


# -- timezones -----------------------------------------------------------------


def test_tzid_task_keeps_its_zone() -> None:
    todo = parse_vtodo(
        "DTSTART;TZID=Europe/Sofia:20260701T090000",
        "DUE;TZID=Europe/Sofia:20260701T090000",
        "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
    )
    now = datetime(2026, 7, 1, 12, 0, tzinfo=UTC)  # past 09:00 Sofia (06:00Z)
    assert recurrence.roll_forward(todo, now) is True
    nxt = todo.decoded("DUE")
    assert isinstance(nxt, datetime)
    assert nxt == datetime(2026, 7, 13, 9, 0, tzinfo=SOFIA)
    assert b"TZID=Europe/Sofia" in todo.to_ical()


def test_dst_crossing_preserves_wall_clock() -> None:
    # EEST (+03) ends 2026-10-25: 09:00 wall time stays 09:00, offset shifts.
    todo = parse_vtodo(
        "DUE;TZID=Europe/Sofia:20261020T090000",
        "RRULE:FREQ=WEEKLY;BYDAY=TU",
    )
    now = datetime(2026, 10, 21, 0, 0, tzinfo=UTC)
    assert recurrence.roll_forward(todo, now) is True
    nxt = todo.decoded("DUE")
    assert isinstance(nxt, datetime)
    assert nxt.hour == 9
    assert nxt.utcoffset() == timedelta(hours=2)  # was +03 before the crossing
    assert nxt.date() == date(2026, 10, 27)


def test_now_naive_is_treated_as_utc() -> None:
    todo = parse_vtodo("DUE:20260701T054500Z", "RRULE:FREQ=DAILY")
    assert recurrence.roll_forward(todo, datetime(2026, 7, 3, 12, 0)) is True
    assert todo.decoded("DUE") == datetime(2026, 7, 4, 5, 45, tzinfo=UTC)


def test_allday_roll_forward_uses_local_sofia_day_not_utc() -> None:
    # All-day daily due 07-15; completion instant 2026-07-15 23:30 UTC is
    # already 2026-07-16 02:30 in Europe/Sofia (EEST +03). The next occurrence
    # must be computed in local time (→ 07-17), never in UTC (which would give
    # 07-16, still "today" for the household). Contract F / SYNC-11.
    todo = parse_vtodo("DUE;VALUE=DATE:20260715", "RRULE:FREQ=DAILY")
    now = datetime(2026, 7, 15, 23, 30, tzinfo=UTC)
    assert recurrence.roll_forward(todo, now) is True
    assert todo.decoded("DUE") == date(2026, 7, 17)


def test_allday_local_timezone_is_config_overridable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The same instant, but with the local tz overridden to UTC, rolls only to
    # 07-16 — proving the single config constant drives the all-day rollover.
    monkeypatch.setenv("TASKS_LOCAL_TZ", "UTC")
    todo = parse_vtodo("DUE;VALUE=DATE:20260715", "RRULE:FREQ=DAILY")
    now = datetime(2026, 7, 15, 23, 30, tzinfo=UTC)
    assert recurrence.roll_forward(todo, now) is True
    assert todo.decoded("DUE") == date(2026, 7, 16)


# -- DTSTART/DUE combinations ----------------------------------------------------


def test_dtstart_and_due_move_together_preserving_duration() -> None:
    todo = parse_vtodo(
        "DTSTART:20260701T080000Z",
        "DUE:20260701T090000Z",  # one hour after DTSTART
        "RRULE:FREQ=DAILY",
    )
    now = datetime(2026, 7, 1, 12, 0, tzinfo=UTC)
    assert recurrence.roll_forward(todo, now) is True
    assert todo.decoded("DTSTART") == datetime(2026, 7, 2, 8, 0, tzinfo=UTC)
    assert todo.decoded("DUE") == datetime(2026, 7, 2, 9, 0, tzinfo=UTC)


def test_dtstart_only_rolls_dtstart() -> None:
    todo = parse_vtodo("DTSTART:20260701T080000Z", "RRULE:FREQ=DAILY")
    now = datetime(2026, 7, 1, 12, 0, tzinfo=UTC)
    assert recurrence.roll_forward(todo, now) is True
    assert todo.decoded("DTSTART") == datetime(2026, 7, 2, 8, 0, tzinfo=UTC)
    assert "DUE" not in todo


# -- not recurring / degenerate ---------------------------------------------------


def test_no_rrule_returns_false() -> None:
    todo = parse_vtodo("DUE:20260701T054500Z")
    assert recurrence.roll_forward(todo, datetime(2026, 7, 3, tzinfo=UTC)) is False


def test_rrule_without_any_date_returns_false() -> None:
    todo = parse_vtodo("RRULE:FREQ=DAILY")
    assert recurrence.roll_forward(todo, datetime(2026, 7, 3, tzinfo=UTC)) is False


def test_next_occurrence_none_when_exhausted() -> None:
    todo = parse_vtodo("DUE:20260701T054500Z", "RRULE:FREQ=DAILY;COUNT=1")
    recur = todo["RRULE"]
    base = todo.decoded("DUE")
    assert recurrence.next_occurrence(recur, base, datetime(2026, 8, 1, tzinfo=UTC)) is None


# -- property: COUNT bookkeeping matches a dateutil oracle -------------------------


@settings(max_examples=60, deadline=None)
@given(
    freq=st.sampled_from(["DAILY", "WEEKLY", "MONTHLY"]),
    interval=st.integers(min_value=1, max_value=4),
    count=st.integers(min_value=2, max_value=30),
    days_late=st.integers(min_value=0, max_value=200),
)
def test_roll_forward_matches_dateutil_oracle(
    freq: str, interval: int, count: int, days_late: int
) -> None:
    base = datetime(2026, 7, 1, 6, 30, tzinfo=UTC)
    rule = f"FREQ={freq};INTERVAL={interval};COUNT={count}"
    todo = parse_vtodo("DUE:20260701T063000Z", f"RRULE:{rule}")
    now = base + timedelta(days=days_late, hours=1)

    oracle = rrulestr(rule, dtstart=base)
    expected_next = oracle.after(max(now, base))

    rolled = recurrence.roll_forward(todo, now)
    if expected_next is None:
        assert rolled is False
        # Exhausted rule preserved (vRecur serialization canonicalizes order).
        assert dict(todo["RRULE"]) == dict(vRecur.from_ical(rule))
        return

    assert rolled is True
    new_due = todo.decoded("DUE")
    assert new_due == expected_next

    # Invariant: the rolled rule's final occurrence equals the original's —
    # decrementing COUNT by the consumed occurrences never stretches the rule.
    new_recur = todo["RRULE"]
    new_count = int(new_recur["COUNT"][0])
    assert new_count >= 1
    new_rule = rrulestr(f"FREQ={freq};INTERVAL={interval};COUNT={new_count}", dtstart=new_due)
    assert list(new_rule)[-1] == list(oracle)[-1]


def test_rule_dateutil_cannot_parse_raises_recurrence_error() -> None:
    # icalendar tolerates unknown recur parts; dateutil does not — the engine
    # must surface that as its own error type, not a bare ValueError.
    todo = parse_vtodo("DUE:20260701T054500Z", "RRULE:FREQ=DAILY")
    todo["RRULE"] = vRecur({"FREQ": ["DAILY"], "X-BOGUS": [1]})
    with pytest.raises(recurrence.RecurrenceError):
        recurrence.roll_forward(todo, datetime(2026, 7, 3, tzinfo=UTC))
