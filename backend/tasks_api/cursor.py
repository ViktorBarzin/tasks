"""The Delta Sync cursor: an opaque base64 JSON blob of per-List sync-tokens.

Server-side only — clients echo it back verbatim. Anything undecodable is
treated as "no cursor" (full snapshot), so a corrupted or ancient cursor can
never wedge a client.

Besides the per-List sync-tokens it also carries a small ``href → true-UID``
index (contract D / SYNC-6): only objects whose filename does NOT equal their
UID (Apple-legacy names) are recorded, so a later delete tombstone can carry
the real UID the client stored instead of a filename-derived guess. Keeping it
to the oddballs keeps the cursor small; the common ``<uid>.ics`` case falls
back to the filename at delete time.
"""

import base64
import binascii
import json

_VERSION = 1


def encode_cursor(tokens: dict[str, str], href_uids: dict[str, str] | None = None) -> str:
    payload = json.dumps(
        {"v": _VERSION, "tokens": tokens, "hrefs": href_uids or {}},
        separators=(",", ":"),
    )
    return base64.urlsafe_b64encode(payload.encode()).decode()


def _decode_payload(cursor: str) -> dict[str, object] | None:
    if not cursor:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor.encode()))
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("v") != _VERSION:
        return None
    return payload


def decode_cursor(cursor: str) -> dict[str, str] | None:
    """Per-List sync-tokens, or ``None`` when empty/undecodable (⇒ full snapshot)."""
    payload = _decode_payload(cursor)
    if payload is None:
        return None
    tokens = payload.get("tokens")
    if not isinstance(tokens, dict):
        return None
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in tokens.items()):
        return None
    return tokens


def decode_href_index(cursor: str) -> dict[str, str]:
    """The accumulated ``href → true-UID`` index (empty for an old/absent cursor)."""
    payload = _decode_payload(cursor)
    if payload is None:
        return {}
    hrefs = payload.get("hrefs")
    if not isinstance(hrefs, dict):
        return {}
    return {k: v for k, v in hrefs.items() if isinstance(k, str) and isinstance(v, str)}
