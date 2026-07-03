"""GET /api/sync — Delta Sync between the PWA Replica and Nextcloud (ADR-0001).

Empty (or undecodable) cursor ⇒ full snapshot. Otherwise each List's CalDAV
sync-token from the cursor drives an RFC 6578 delta; a token the server no
longer honors escalates the whole response back to a full snapshot
(``full=true``) so the client can rebuild its Replica without guessing.
"""

import logging

from fastapi import APIRouter, Depends

from tasks_api import cursor as cursor_codec
from tasks_api import ics_mapper
from tasks_api.auth import current_username
from tasks_api.caldav_engine import (
    CalDAVEngine,
    CalDAVNotFound,
    CalDAVSyncTokenInvalid,
    ListInfo,
    ObjectState,
)
from tasks_api.deps import engine_for_account
from tasks_api.ics_mapper import MapperError
from tasks_api.schemas import SyncResponse, Task, TaskList

logger = logging.getLogger(__name__)

router = APIRouter()


def _task_from_state(state: ObjectState, list_id: str) -> Task | None:
    try:
        parsed = ics_mapper.parse_task(state.ics)
    except MapperError as exc:
        logger.warning(
            "skipping unparseable object", extra={"href": state.href, "error": str(exc)}
        )
        return None
    if parsed is None or not parsed.uid:
        return None
    return Task(
        uid=parsed.uid,
        list_id=list_id,
        title=parsed.title,
        notes=parsed.notes,
        due=parsed.due,
        due_has_time=parsed.due_has_time,
        priority=parsed.priority,
        completed=parsed.completed,
        completed_at=parsed.completed_at,
        recurring=parsed.recurring,
        deleted=False,
    )


def _tombstone(uid: str, list_id: str) -> Task:
    return Task(
        uid=uid,
        list_id=list_id,
        title="",
        notes="",
        due=None,
        due_has_time=False,
        priority=0,
        completed=False,
        completed_at=None,
        recurring=False,
        deleted=True,
    )


def _index_oddball(index: dict[str, str], href: str, uid: str) -> None:
    """Record ``href → uid`` only when the filename ≠ UID (Apple-legacy names),
    so a later delete tombstone resolves the real UID (contract D)."""
    if CalDAVEngine.uid_hint_from_href(href) != uid:
        index[href] = uid


async def _full_list_state(
    engine: CalDAVEngine, info: ListInfo
) -> tuple[str, list[Task], dict[str, str]]:
    """Sync-token first, objects second: changes in between re-report later
    (at-least-once) instead of getting lost."""
    token = await engine.get_sync_token(info.href)
    states = await engine.fetch_all_tasks(info.href)
    tasks: list[Task] = []
    href_uids: dict[str, str] = {}
    for s in states:
        task = _task_from_state(s, info.id)
        if task is not None:
            tasks.append(task)
            _index_oddball(href_uids, s.href, task.uid)
    return token, tasks, href_uids


async def _full_snapshot(engine: CalDAVEngine, lists: list[ListInfo]) -> SyncResponse:
    tokens: dict[str, str] = {}
    tasks: list[Task] = []
    href_uids: dict[str, str] = {}
    for info in lists:
        token, list_tasks, list_index = await _full_list_state(engine, info)
        tokens[info.id] = token
        tasks.extend(list_tasks)
        href_uids.update(list_index)
    return SyncResponse(
        cursor=cursor_codec.encode_cursor(tokens, href_uids),
        full=True,
        lists=[TaskList(id=li.id, name=li.name, deleted=False) for li in lists],
        tasks=tasks,
    )


async def _delta(
    engine: CalDAVEngine,
    lists: list[ListInfo],
    old_tokens: dict[str, str],
    old_index: dict[str, str],
) -> SyncResponse:
    tokens: dict[str, str] = {}
    tasks: list[Task] = []
    href_uids: dict[str, str] = dict(old_index)  # carry the index forward
    list_entries = [TaskList(id=li.id, name=li.name, deleted=False) for li in lists]
    for info in lists:
        old_token = old_tokens.get(info.id)
        if old_token is None:
            # A List the client has never seen — ship it whole.
            token, list_tasks, list_index = await _full_list_state(engine, info)
            tokens[info.id] = token
            tasks.extend(list_tasks)
            href_uids.update(list_index)
            continue
        delta = await engine.sync_delta(info.href, old_token)
        tokens[info.id] = delta.sync_token
        for s in delta.changed:
            task = _task_from_state(s, info.id)
            if task is not None:
                tasks.append(task)
                _index_oddball(href_uids, s.href, task.uid)
        for href in delta.removed_hrefs:
            # Resolve the object's true UID from the index; the common
            # <uid>.ics case is not indexed and falls back to the filename.
            uid = href_uids.pop(href, None) or CalDAVEngine.uid_hint_from_href(href)
            tasks.append(_tombstone(uid, info.id))
    current_ids = {li.id for li in lists}
    list_entries.extend(
        TaskList(id=gone, name="", deleted=True)
        for gone in sorted(set(old_tokens) - current_ids)
    )
    return SyncResponse(
        cursor=cursor_codec.encode_cursor(tokens, href_uids),
        full=False,
        lists=list_entries,
        tasks=tasks,
    )


@router.get("/sync", response_model=SyncResponse)
async def sync(
    cursor: str = "",
    username: str = Depends(current_username),
    engine: CalDAVEngine = Depends(engine_for_account),
) -> SyncResponse:
    """Contract: empty cursor ⇒ full snapshot (``full=true``); else changes since it."""
    old_tokens = cursor_codec.decode_cursor(cursor)
    lists = await engine.list_task_lists()
    if old_tokens is None:
        response = await _full_snapshot(engine, lists)
    else:
        try:
            response = await _delta(
                engine, lists, old_tokens, cursor_codec.decode_href_index(cursor)
            )
        except (CalDAVSyncTokenInvalid, CalDAVNotFound) as exc:
            # Expired token, or a List deleted+recreated mid-cycle: resync.
            logger.info("delta impossible, escalating to full snapshot",
                        extra={"user": username, "reason": str(exc)})
            lists = await engine.list_task_lists()
            response = await _full_snapshot(engine, lists)
    logger.info(
        "sync served",
        extra={
            "user": username,
            "full": response.full,
            "lists": len(response.lists),
            "tasks": len(response.tasks),
        },
    )
    return response
