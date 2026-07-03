"""POST /api/ops — replay a batch of client Ops against Nextcloud (ADR-0001).

Guarantees, per the contract:

- **In order**: ops apply sequentially; each gets its own result.
- **Idempotent**: a re-sent ``op_id`` (journal table) or an already-existing
  create UID (``If-None-Match: *``) returns ``duplicate``, never double-applies.
- **Silent LWW**: a write that trips a stale ETag (412) refetches the server
  copy, re-applies the Op's own field changes on top, and PUTs again —
  reported as ``lww_reapplied``.
- ``task_move`` = create-in-target-with-same-UID + delete-from-source.
- List CRUD = MKCALENDAR / PROPPATCH / DELETE.

Kind-specific Op fields (the client sends exactly these):

- ``task_create``: ``uid``, ``list_id``, ``title`` (+ ``notes``, ``due``,
  ``due_has_time``, ``priority``)
- ``task_update``: ``uid`` (+ ``list_id`` locator hint, and any of ``title``,
  ``notes``, ``due``, ``due_has_time``, ``priority`` — present fields are set)
- ``task_complete``: ``uid`` (+ optional ``completed_at`` ISO datetime)
- ``task_uncomplete`` / ``task_delete``: ``uid``
- ``task_move``: ``uid``, ``list_id`` (SOURCE hint), ``to_list_id`` (DESTINATION)
- ``list_create``: ``list_id`` (client-generated, URL-safe), ``name``
- ``list_rename``: ``list_id``, ``name``
- ``list_delete``: ``list_id``
"""

import logging
import re
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Final, Literal, get_args

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tasks_api import ics_mapper
from tasks_api.auth import current_username
from tasks_api.caldav_engine import (
    CalDAVAlreadyExists,
    CalDAVEngine,
    CalDAVError,
    CalDAVNotFound,
    CalDAVPreconditionFailed,
    CalDAVTransient,
    CalDAVUnauthorized,
    ListInfo,
    ObjectState,
)
from tasks_api.deps import engine_for_account, get_session
from tasks_api.ics_mapper import MapperError
from tasks_api.models import AppliedOp
from tasks_api.recurrence import RecurrenceError
from tasks_api.schemas import Op, OpKind, OpResult, OpsRequest, OpsResponse

logger = logging.getLogger(__name__)

router = APIRouter()

_MAX_ETAG_RETRIES = 3
_LIST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
#: The kinds the batch will attempt; anything else is a per-op ``error`` (B).
_VALID_KINDS: Final[frozenset[str]] = frozenset(get_args(OpKind))

ApplyStatus = Literal["applied", "lww_reapplied", "duplicate"]


class OpError(Exception):
    """A per-Op failure — reported as ``status: "error"``, batch continues."""


class _ListCache:
    """Lazily-fetched Lists for locating tasks; invalidated by list ops."""

    def __init__(self, engine: CalDAVEngine) -> None:
        self._engine = engine
        self._lists: list[ListInfo] | None = None

    async def get(self) -> list[ListInfo]:
        if self._lists is None:
            self._lists = await self._engine.list_task_lists()
        return self._lists

    def invalidate(self) -> None:
        self._lists = None


def _extras(op: Op) -> dict[str, object]:
    return dict(op.model_extra or {})


def _require_uid(op: Op) -> str:
    if not op.uid:
        raise OpError(f"{op.kind} requires uid")
    return op.uid


def _require_list_id(op: Op) -> str:
    if not op.list_id:
        raise OpError(f"{op.kind} requires list_id")
    return op.list_id


def _require_to_list_id(op: Op) -> str:
    if not op.to_list_id:
        raise OpError(f"{op.kind} requires to_list_id")
    return op.to_list_id


def _require_str(op: Op, field: str) -> str:
    value = _extras(op).get(field)
    if not isinstance(value, str) or not value:
        raise OpError(f"{op.kind} requires {field}")
    return value


def _mutable_fields(op: Op) -> dict[str, object]:
    extras = _extras(op)
    return {k: extras[k] for k in ics_mapper.MUTABLE_FIELDS if k in extras}


async def _find_task(
    engine: CalDAVEngine, lists: _ListCache, uid: str, hint_list_id: str | None
) -> tuple[ListInfo, ObjectState] | None:
    """Locate a Task by UID: the hinted List first, then the rest."""
    infos = await lists.get()
    ordered = sorted(infos, key=lambda li: li.id != hint_list_id)
    for info in ordered:
        state = await engine.find_task(info.href, uid)
        if state is not None:
            return info, state
    return None


async def _require_task(
    engine: CalDAVEngine, lists: _ListCache, op: Op
) -> tuple[ListInfo, ObjectState]:
    uid = _require_uid(op)
    found = await _find_task(engine, lists, uid, op.list_id)
    if found is None:
        raise OpError(f"task {uid!r} not found")
    return found


async def _rmw(
    engine: CalDAVEngine,
    state: ObjectState,
    transform: Callable[[bytes], bytes],
) -> ApplyStatus:
    """Read-modify-write with If-Match; 412 ⇒ refetch + re-apply (Silent LWW)."""
    for attempt in range(_MAX_ETAG_RETRIES):
        new_ics = transform(state.ics)
        try:
            await engine.put_object(state.href, new_ics, if_match=state.etag or None)
        except CalDAVPreconditionFailed:
            try:
                state = await engine.get_object(state.href)
            except CalDAVNotFound as exc:
                raise OpError("task vanished while updating it") from exc
            continue
        return "applied" if attempt == 0 else "lww_reapplied"
    raise OpError(f"etag conflict persisted after {_MAX_ETAG_RETRIES} attempts")


async def _task_create(engine: CalDAVEngine, op: Op, now: datetime) -> ApplyStatus:
    uid = _require_uid(op)
    list_id = _require_list_id(op)
    fields = _mutable_fields(op)
    if "title" not in fields:
        raise OpError("task_create requires title")
    ics = ics_mapper.build_vtodo(uid, fields, now)
    try:
        await engine.put_object(engine.object_path(list_id, uid), ics, if_none_match=True)
    except CalDAVPreconditionFailed:
        return "duplicate"  # create UID already exists — replay, not a new task
    except CalDAVNotFound as exc:
        raise OpError(f"list {list_id!r} not found") from exc
    return "applied"


async def _task_update(
    engine: CalDAVEngine, lists: _ListCache, op: Op, now: datetime
) -> ApplyStatus:
    fields = _mutable_fields(op)
    if not fields:
        raise OpError("task_update carries no task fields")
    _, state = await _require_task(engine, lists, op)
    return await _rmw(engine, state, lambda ics: ics_mapper.apply_fields(ics, fields, now))


def _parse_completed_at(op: Op) -> datetime | None:
    raw = _extras(op).get("completed_at")
    if raw is None:
        return None
    if not isinstance(raw, str):
        raise OpError(f"invalid completed_at {raw!r}")
    try:
        value = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise OpError(f"invalid completed_at {raw!r}: {exc}") from exc
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


async def _task_complete(
    engine: CalDAVEngine, lists: _ListCache, op: Op, now: datetime
) -> ApplyStatus:
    completed_at = _parse_completed_at(op)
    _, state = await _require_task(engine, lists, op)
    return await _rmw(
        engine, state, lambda ics: ics_mapper.apply_complete(ics, now, completed_at)
    )


async def _task_uncomplete(
    engine: CalDAVEngine, lists: _ListCache, op: Op, now: datetime
) -> ApplyStatus:
    _, state = await _require_task(engine, lists, op)
    return await _rmw(engine, state, lambda ics: ics_mapper.apply_uncomplete(ics, now))


async def _task_delete(engine: CalDAVEngine, lists: _ListCache, op: Op) -> ApplyStatus:
    uid = _require_uid(op)
    found = await _find_task(engine, lists, uid, op.list_id)
    if found is None:
        return "applied"  # end state already reached
    _, state = found
    for attempt in range(_MAX_ETAG_RETRIES):
        try:
            await engine.delete_object(state.href, if_match=state.etag or None)
        except CalDAVNotFound:
            return "applied"
        except CalDAVPreconditionFailed:
            try:
                state = await engine.get_object(state.href)
            except CalDAVNotFound:
                return "applied"
            continue
        return "applied" if attempt == 0 else "lww_reapplied"
    raise OpError(f"etag conflict persisted after {_MAX_ETAG_RETRIES} attempts")


async def _task_move(engine: CalDAVEngine, lists: _ListCache, op: Op) -> ApplyStatus:
    """Move = PUT the same UID into the target List, then DELETE the source.

    Locates the Task in its SOURCE (``op.list_id`` hint) first, so a half-done
    move that left a copy in the target does not shadow the source (contract A).
    """
    uid = _require_uid(op)
    to_list_id = _require_to_list_id(op)
    infos = await lists.get()
    target = next((li for li in infos if li.id == to_list_id), None)
    if target is None:
        raise OpError(f"list {to_list_id!r} not found")

    found = await _find_task(engine, lists, uid, op.list_id)
    if found is None:
        already_there = await engine.find_task(target.href, uid)
        if already_there is not None:
            return "duplicate"  # a replay of an already-finished move
        raise OpError(f"task {uid!r} not found")

    source_info, state = found
    if source_info.id == to_list_id:
        return "duplicate"  # already in the target List

    target_href = engine.object_path(to_list_id, uid)
    try:
        await engine.put_object(target_href, state.ics, if_none_match=True)
    except CalDAVPreconditionFailed:
        # A half-finished earlier move left a copy — last write wins.
        await engine.put_object(target_href, state.ics)
    try:
        await engine.delete_object(state.href, if_match=state.etag or None)
    except CalDAVPreconditionFailed:
        # The source changed under us; the move still wins (Silent LWW).
        await engine.delete_object(state.href)
    except CalDAVNotFound:
        pass
    return "applied"


async def _list_create(engine: CalDAVEngine, lists: _ListCache, op: Op) -> ApplyStatus:
    list_id = _require_list_id(op)
    name = _require_str(op, "name")
    if not _LIST_ID_RE.match(list_id):
        raise OpError(f"invalid list_id {list_id!r} (must be URL-safe)")
    lists.invalidate()
    try:
        await engine.create_list(list_id, name)
    except CalDAVAlreadyExists:
        return "duplicate"
    return "applied"


async def _list_rename(engine: CalDAVEngine, lists: _ListCache, op: Op) -> ApplyStatus:
    list_id = _require_list_id(op)
    name = _require_str(op, "name")
    lists.invalidate()
    try:
        await engine.rename_list(list_id, name)
    except CalDAVNotFound as exc:
        raise OpError(f"list {list_id!r} not found") from exc
    return "applied"


async def _list_delete(engine: CalDAVEngine, lists: _ListCache, op: Op) -> ApplyStatus:
    list_id = _require_list_id(op)
    lists.invalidate()
    try:
        await engine.delete_list(list_id)
    except CalDAVNotFound:
        return "applied"  # end state already reached
    return "applied"


async def _apply_op(
    engine: CalDAVEngine, lists: _ListCache, op: Op, now: datetime
) -> ApplyStatus:
    handlers: dict[str, Callable[[], Awaitable[ApplyStatus]]] = {
        "task_create": lambda: _task_create(engine, op, now),
        "task_update": lambda: _task_update(engine, lists, op, now),
        "task_complete": lambda: _task_complete(engine, lists, op, now),
        "task_uncomplete": lambda: _task_uncomplete(engine, lists, op, now),
        "task_delete": lambda: _task_delete(engine, lists, op),
        "task_move": lambda: _task_move(engine, lists, op),
        "list_create": lambda: _list_create(engine, lists, op),
        "list_rename": lambda: _list_rename(engine, lists, op),
        "list_delete": lambda: _list_delete(engine, lists, op),
    }
    return await handlers[op.kind]()


async def _journaled_op_ids(
    session: AsyncSession, username: str, op_ids: list[str]
) -> set[str]:
    if not op_ids:
        return set()
    result = await session.execute(
        select(AppliedOp.op_id).where(
            AppliedOp.authentik_username == username, AppliedOp.op_id.in_(op_ids)
        )
    )
    return set(result.scalars())


@router.post("/ops", response_model=OpsResponse)
async def apply_ops(
    payload: OpsRequest,
    username: str = Depends(current_username),
    session: AsyncSession = Depends(get_session),
    engine: CalDAVEngine = Depends(engine_for_account),
) -> OpsResponse:
    """Contract: one OpResult per Op — applied | lww_reapplied | duplicate | error."""
    now = datetime.now(UTC)
    lists = _ListCache(engine)
    journaled = await _journaled_op_ids(session, username, [op.op_id for op in payload.ops])
    results: list[OpResult] = []

    for op in payload.ops:
        if op.op_id in journaled:
            results.append(OpResult(op_id=op.op_id, status="duplicate", error=None))
            continue
        if op.kind not in _VALID_KINDS:
            # Unknown/unsupported kind is a permanent, isolated per-op error —
            # never a whole-batch 422 (contract B).
            results.append(
                OpResult(op_id=op.op_id, status="error", error=f"unknown op kind {op.kind!r}")
            )
            continue
        try:
            status = await _apply_op(engine, lists, op, now)
        except CalDAVUnauthorized:
            raise  # whole batch aborts → 401 envelope → client re-onboards
        except CalDAVTransient as exc:
            # Transient upstream (Nextcloud 5xx / timeout): the op did NOT apply.
            # STOP the batch here — this op and every op after it stay queued in
            # order (omitted from results) for the next drain (contract B).
            logger.info(
                "op deferred, transient upstream failure — batch stopped",
                extra={"user": username, "op_id": op.op_id, "kind": op.kind, "error": str(exc)},
            )
            results.append(OpResult(op_id=op.op_id, status="retry", error=str(exc)))
            break
        except (OpError, MapperError, RecurrenceError) as exc:
            results.append(OpResult(op_id=op.op_id, status="error", error=str(exc)))
            continue
        except CalDAVError as exc:
            logger.warning(
                "op failed against Nextcloud",
                extra={"user": username, "op_id": op.op_id, "kind": op.kind, "error": str(exc)},
            )
            results.append(OpResult(op_id=op.op_id, status="error", error=str(exc)))
            continue
        session.add(
            AppliedOp(authentik_username=username, op_id=op.op_id, kind=op.kind, status=status)
        )
        await session.commit()
        journaled.add(op.op_id)
        if status == "lww_reapplied":
            logger.info(
                "silent LWW re-apply",
                extra={"user": username, "op_id": op.op_id, "kind": op.kind},
            )
        results.append(OpResult(op_id=op.op_id, status=status, error=None))

    logger.info(
        "ops batch applied",
        extra={
            "user": username,
            "count": len(payload.ops),
            "statuses": {s: sum(1 for r in results if r.status == s)
                         for s in {r.status for r in results}},
        },
    )
    return OpsResponse(results=results)
