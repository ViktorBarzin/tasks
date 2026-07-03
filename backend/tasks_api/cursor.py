"""The Delta Sync cursor: an opaque base64 JSON blob of per-List sync-tokens.

Server-side only — clients echo it back verbatim. Anything undecodable is
treated as "no cursor" (full snapshot), so a corrupted or ancient cursor can
never wedge a client.
"""

import base64
import binascii
import json

_VERSION = 1


def encode_cursor(tokens: dict[str, str]) -> str:
    payload = json.dumps({"v": _VERSION, "tokens": tokens}, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode()).decode()


def decode_cursor(cursor: str) -> dict[str, str] | None:
    """Per-List sync-tokens, or ``None`` when empty/undecodable (⇒ full snapshot)."""
    if not cursor:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor.encode()))
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("v") != _VERSION:
        return None
    tokens = payload.get("tokens")
    if not isinstance(tokens, dict):
        return None
    if not all(isinstance(k, str) and isinstance(v, str) for k, v in tokens.items()):
        return None
    return tokens
