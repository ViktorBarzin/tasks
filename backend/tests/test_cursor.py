"""The Delta Sync cursor is an opaque, corruption-proof blob: anything the
server did not mint decodes to None (⇒ full snapshot), never an error."""

import base64
import json

from hypothesis import given
from hypothesis import strategies as st

from tasks_api.cursor import decode_cursor, encode_cursor


def test_round_trip() -> None:
    tokens = {
        "personal": "http://sabre.io/ns/sync/42",
        "work": "http://sabre.io/ns/sync/7",
    }
    assert decode_cursor(encode_cursor(tokens)) == tokens


def test_empty_tokens_round_trip() -> None:
    assert decode_cursor(encode_cursor({})) == {}


def test_cursor_is_urlsafe_ascii() -> None:
    cursor = encode_cursor({"lišta/á": "token with spaces & ?="})
    assert cursor == cursor.strip()
    base64.urlsafe_b64decode(cursor)  # decodes cleanly — no padding surprises


def test_empty_cursor_means_full_snapshot() -> None:
    assert decode_cursor("") is None


def test_garbage_is_none_not_error() -> None:
    assert decode_cursor("not-base64 at all!!") is None
    assert decode_cursor(base64.urlsafe_b64encode(b"not json").decode()) is None
    assert decode_cursor(base64.urlsafe_b64encode(b'"a json string"').decode()) is None


def test_wrong_version_is_none() -> None:
    stale = base64.urlsafe_b64encode(json.dumps({"v": 0, "tokens": {}}).encode()).decode()
    assert decode_cursor(stale) is None


def test_non_string_tokens_are_none() -> None:
    bad = base64.urlsafe_b64encode(
        json.dumps({"v": 1, "tokens": {"personal": 42}}).encode()
    ).decode()
    assert decode_cursor(bad) is None
    missing = base64.urlsafe_b64encode(json.dumps({"v": 1}).encode()).decode()
    assert decode_cursor(missing) is None


@given(st.dictionaries(st.text(min_size=1), st.text()))
def test_any_token_map_round_trips(tokens: dict[str, str]) -> None:
    assert decode_cursor(encode_cursor(tokens)) == tokens


@given(st.text())
def test_decode_never_raises(junk: str) -> None:
    result = decode_cursor(junk)
    assert result is None or isinstance(result, dict)
