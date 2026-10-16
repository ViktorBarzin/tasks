"""Differential oracle: runs the Python build's mapper, recurrence and cursor
on cases sent by parity.server.test.ts and prints what it got.

Usage: python -I python_oracle.py <backend dir>  (cases on stdin as JSON)
Not part of the app; it exists only while the Python build is the reference.
"""

import json
import os
import sys
from dataclasses import asdict
from datetime import datetime

sys.path.insert(0, sys.argv[1])

from icalendar import Calendar  # noqa: E402

from tasks_api import cursor, ics_mapper  # noqa: E402


def unfold(ics: bytes) -> list[str]:
    text = ics.decode().replace("\r\n ", "").replace("\r\n\t", "")
    return [line for line in text.split("\r\n") if line]


def summarize(ics: bytes) -> dict[str, object]:
    cal = Calendar.from_ical(ics)
    todo = next(t for t in cal.walk("VTODO") if "RECURRENCE-ID" not in t)

    def iso(name: str) -> str | None:
        return todo.decoded(name).isoformat() if name in todo else None

    rule = todo.get("RRULE")
    count = rule.get("COUNT", [None])[0] if rule is not None else None
    return {
        "due": iso("DUE"),
        "dtstart": iso("DTSTART"),
        "completed": iso("COMPLETED"),
        "status": str(todo.get("STATUS", "")),
        "count": count,
    }


def run(case: dict[str, object]) -> dict[str, object]:
    kind = case["kind"]
    if kind == "complete":
        os.environ["TASKS_LOCAL_TZ"] = str(case["tz"])
        now = datetime.fromisoformat(str(case["now"]))
        out = ics_mapper.apply_complete(str(case["ics"]).encode(), now)
        return summarize(out)
    if kind == "fields":
        now = datetime.fromisoformat(str(case["now"]))
        fields = case["fields"]
        assert isinstance(fields, dict)
        out = ics_mapper.apply_fields(str(case["ics"]).encode(), fields, now)
        parsed = ics_mapper.parse_task(out)
        return {"lines": unfold(out), "task": asdict(parsed) if parsed else None}
    if kind == "build":
        now = datetime.fromisoformat(str(case["now"]))
        fields = case["fields"]
        assert isinstance(fields, dict)
        out = ics_mapper.build_vtodo(str(case["uid"]), fields, now)
        parsed = ics_mapper.parse_task(out)
        return {"lines": unfold(out), "task": asdict(parsed) if parsed else None}
    if kind == "parse":
        parsed = ics_mapper.parse_task(str(case["ics"]).encode())
        return {"task": asdict(parsed) if parsed else None}
    if kind == "cursor":
        tokens = case["tokens"]
        hrefs = case["hrefs"]
        assert isinstance(tokens, dict) and isinstance(hrefs, dict)
        return {"cursor": cursor.encode_cursor(tokens, hrefs)}
    raise ValueError(f"unknown case kind {kind!r}")


results = []
for case in json.load(sys.stdin):
    try:
        results.append({"ok": run(case)})
    except Exception as exc:  # noqa: BLE001 - the error class is the result
        results.append({"error": type(exc).__name__, "message": str(exc)})
json.dump(results, sys.stdout)
