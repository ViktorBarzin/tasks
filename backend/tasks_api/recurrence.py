"""Completion roll-forward for Recurring Tasks (dateutil.rrule).

Completing a Recurring Task does not close it: DUE (and DTSTART, when present)
advance to the next occurrence strictly after ``max(now, current base)`` —
"after now" skips every occurrence missed while the task sat overdue; the max
guard keeps an *early* completion from re-landing on the current occurrence.
The RRULE itself is preserved verbatim except COUNT, which decrements by the
occurrences consumed so the rule still exhausts on schedule from its new
anchor. An exhausted rule (COUNT spent / UNTIL passed) means: complete
normally (the caller handles that when this returns False).
"""

from datetime import UTC, date, datetime, timedelta

from dateutil.rrule import rrule, rruleset, rrulestr
from icalendar import Todo
from icalendar.prop import vRecur


class RecurrenceError(Exception):
    """Raised when an RRULE cannot be interpreted."""


def _as_datetime(value: date | datetime) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime(value.year, value.month, value.day)


def _comparable_now(now: datetime, base: datetime) -> datetime:
    """Bring ``now`` into the base's naive/aware domain so dateutil can compare."""
    aware_now = now if now.tzinfo is not None else now.replace(tzinfo=UTC)
    if base.tzinfo is not None:
        return aware_now
    return aware_now.astimezone(UTC).replace(tzinfo=None)


def _sanitized_rule_text(recur: vRecur, base: datetime) -> str:
    """Serialize the RRULE for dateutil, aligning UNTIL to the base's tz domain.

    Apple emits UNTIL as a UTC date-time even for all-day tasks; dateutil
    refuses to mix naive and aware datetimes, so UNTIL is coerced to the
    domain of the recurrence base for computation only — the stored RRULE
    property is never rewritten (except COUNT, by the caller).
    """
    parts = vRecur(recur)  # copy — never mutate the stored property here
    untils = parts.get("UNTIL")
    if untils:
        until = _as_datetime(untils[0])
        if base.tzinfo is not None and until.tzinfo is None:
            until = until.replace(tzinfo=UTC)
        elif base.tzinfo is None and until.tzinfo is not None:
            until = until.astimezone(UTC).replace(tzinfo=None)
        parts["UNTIL"] = [until]
    return str(parts.to_ical().decode("utf-8"))


def _build_rule(recur: vRecur, base: datetime) -> rrule:
    try:
        rule = rrulestr(_sanitized_rule_text(recur, base), dtstart=base)
    except (ValueError, TypeError) as exc:
        raise RecurrenceError(f"unsupported RRULE {recur.to_ical()!r}: {exc}") from exc
    if isinstance(rule, rruleset):
        raise RecurrenceError("RRULE sets are not supported")
    return rule


def next_occurrence(recur: vRecur, base: date | datetime, now: datetime) -> datetime | None:
    """First occurrence strictly after ``max(now, base)``; None when exhausted."""
    base_dt = _as_datetime(base)
    rule = _build_rule(recur, base_dt)
    threshold = max(_comparable_now(now, base_dt), base_dt)
    result = rule.after(threshold)
    return result


def _consumed_before(recur: vRecur, base: datetime, nxt: datetime) -> int:
    """How many occurrences the roll skips over: those in ``[base, nxt)``."""
    rule = _build_rule(recur, base)
    epsilon = timedelta(microseconds=1)
    return len(rule.between(base - epsilon, nxt, inc=False))


def roll_forward(todo: Todo, now: datetime) -> bool:
    """Advance DUE/DTSTART to the next occurrence; ``False`` = complete normally.

    Mutates ``todo`` in place only when it rolls. Returns False when the task
    is not recurring, has no date to roll, or the rule is exhausted.
    """
    recur = todo.get("RRULE")
    if not isinstance(recur, vRecur):
        return False

    has_start = "DTSTART" in todo
    has_due = "DUE" in todo
    if not has_start and not has_due:
        return False

    raw_base = todo.decoded("DTSTART") if has_start else todo.decoded("DUE")
    if not isinstance(raw_base, date | datetime):
        raise RecurrenceError(f"unsupported recurrence base value: {raw_base!r}")
    base_dt = _as_datetime(raw_base)

    nxt = next_occurrence(recur, raw_base, now)
    if nxt is None:
        return False

    counts = recur.get("COUNT")
    if counts:
        consumed = _consumed_before(recur, base_dt, nxt)
        # nxt exists, so at least one occurrence remains: never drops below 1.
        recur["COUNT"] = [int(counts[0]) - consumed]

    def write(name: str, original: date | datetime, value: datetime) -> None:
        todo.pop(name, None)
        if isinstance(original, datetime):
            todo.add(name, value)
        else:
            todo.add(name, value.date())

    if has_start and has_due:
        raw_due = todo.decoded("DUE")
        if not isinstance(raw_due, date | datetime):
            raise RecurrenceError(f"unsupported DUE value: {raw_due!r}")
        duration = _as_datetime(raw_due) - base_dt
        write("DTSTART", raw_base, nxt)
        write("DUE", raw_due, nxt + duration)
    elif has_start:
        write("DTSTART", raw_base, nxt)
    else:
        write("DUE", raw_base, nxt)
    return True
