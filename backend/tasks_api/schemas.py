"""Pydantic models for THE API CONTRACT (docs/2026-07-03-tasks-pwa-design.md).

Both the PWA and this backend build against exactly these shapes — do not deviate.
All routes live under /api and authenticate via the X-Authentik-Username header
(see tasks_api.auth).
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict

OpKind = Literal[
    "task_create",
    "task_update",
    "task_complete",
    "task_uncomplete",
    "task_move",
    "task_delete",
    "list_create",
    "list_rename",
    "list_delete",
]

# Per-op outcome (contract B). ``retry`` = transient upstream (Nextcloud 5xx /
# timeout), NOT applied, safe to resend; ``error`` = permanent (4xx, validation,
# unknown kind), never succeeds as-is.
OpStatus = Literal["applied", "lww_reapplied", "duplicate", "retry", "error"]

# RFC 5545 PRIORITY, Apple mapping: 0=None, 9=Low, 5=Medium, 1=High (CONTEXT.md).
Priority = Literal[0, 1, 5, 9]


class MeResponse(BaseModel):
    """GET /api/me."""

    username: str
    connected: bool


class OnboardRequest(BaseModel):
    """POST /api/onboard — 204 after live CalDAV validation, 401 if invalid."""

    nc_username: str
    app_password: str


class TaskList(BaseModel):
    """A List (domain term) — a CalDAV calendar collection holding VTODOs."""

    id: str
    name: str
    deleted: bool


class Task(BaseModel):
    """A Task — maps 1:1 to a CalDAV VTODO."""

    uid: str
    list_id: str
    title: str
    notes: str
    due: str | None  # ISO date (all-day) or datetime; see due_has_time
    due_has_time: bool
    priority: Priority
    completed: bool
    completed_at: str | None
    recurring: bool
    deleted: bool


class SyncResponse(BaseModel):
    """GET /api/sync — Delta Sync payload. Empty request cursor ⇒ full snapshot.

    The cursor is an opaque base64 JSON blob wrapping per-List CalDAV
    sync-tokens; it is server-side only and clients must treat it as a black box.
    """

    cursor: str
    full: bool
    lists: list[TaskList]
    tasks: list[Task]


class Op(BaseModel):
    """A single client mutation, replayed idempotently by ``op_id``.

    Kind-specific fields ride along as extras. Task ops carry ``uid``
    (``task_create``'s uid is client-generated); list ops carry ``list_id``.
    For ``task_move`` the client sends BOTH ``list_id`` (SOURCE) and
    ``to_list_id`` (DESTINATION) so the server locates the Task in its source
    first (contract A / SYNC-1).
    """

    model_config = ConfigDict(extra="allow")

    op_id: str
    # Any string: the batch validates each kind per-op so one unsupported kind
    # becomes a per-op ``error``, never a whole-batch 422 (contract B). Valid
    # kinds are ``OpKind``.
    kind: str
    uid: str | None = None
    list_id: str | None = None
    to_list_id: str | None = None


class OpsRequest(BaseModel):
    """POST /api/ops request body."""

    ops: list[Op]


class OpResult(BaseModel):
    """Outcome of one Op. Replays MUST be idempotent: a re-sent op_id or an
    already-existing create UID returns "duplicate", never a double-apply."""

    op_id: str
    status: OpStatus
    error: str | None = None


class OpsResponse(BaseModel):
    """POST /api/ops response body — one result per submitted Op."""

    results: list[OpResult]
