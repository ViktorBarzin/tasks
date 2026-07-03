"""Per-user CalDAV client for Nextcloud — the only module that speaks DAV.

Built directly on httpx (async, and mockable with ``httpx.MockTransport`` so
the whole test suite runs with zero network). It implements exactly the slice
of RFC 4791/6578 this app needs:

- PROPFIND current-user-principal (Onboarding's live credential check)
- PROPFIND Depth:1 on the calendar home → VTODO-capable Lists
- REPORT sync-collection per List (Delta Sync), falling back to a full
  calendar-query REPORT when the server rejects the sync-token
- REPORT calendar-multiget / calendar-query, GET/PUT/DELETE with ETags
  (If-Match / If-None-Match), MKCALENDAR, PROPPATCH

Hrefs returned by the server are used verbatim; engine-relative paths (e.g.
``/calendars/<user>/<list>/``) are resolved under the configured base URL.
"""

import logging
from dataclasses import dataclass
from types import TracebackType
from typing import Self
from urllib.parse import quote, unquote, urlsplit
from xml.etree import ElementTree
from xml.sax.saxutils import escape

import httpx

logger = logging.getLogger(__name__)

DAV_NS = "DAV:"
CALDAV_NS = "urn:ietf:params:xml:ns:caldav"
_NS = {"d": DAV_NS, "c": CALDAV_NS}


class CalDAVError(Exception):
    """Base for all CalDAV failures."""


class CalDAVUnauthorized(CalDAVError):
    """Nextcloud rejected the app password (revoked/rotated → re-onboard)."""


class CalDAVNotFound(CalDAVError):
    """The object or collection does not exist."""


class CalDAVPreconditionFailed(CalDAVError):
    """An ETag precondition (If-Match / If-None-Match) failed — stale write."""


class CalDAVAlreadyExists(CalDAVError):
    """MKCALENDAR target already exists."""


class CalDAVSyncTokenInvalid(CalDAVError):
    """The server no longer honors this sync-token — resync from scratch."""


@dataclass(frozen=True)
class ListInfo:
    """A VTODO-capable calendar collection (a List)."""

    id: str
    href: str
    name: str


@dataclass(frozen=True)
class ObjectState:
    """One CalDAV object as fetched: server href + ETag + raw ICS."""

    href: str
    etag: str
    ics: bytes


@dataclass(frozen=True)
class DeltaResult:
    """Outcome of one per-List sync round."""

    changed: list[ObjectState]
    removed_hrefs: list[str]
    sync_token: str


def _text(element: ElementTree.Element | None) -> str:
    return element.text or "" if element is not None else ""


class CalDAVEngine:
    """A CalDAV session for one user's Nextcloud account (app-password auth)."""

    def __init__(
        self,
        base_url: str,
        nc_username: str,
        app_password: str,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        parts = urlsplit(base_url.rstrip("/"))
        self._origin = f"{parts.scheme}://{parts.netloc}"
        self._base_path = parts.path
        self.nc_username = nc_username
        self._client = httpx.AsyncClient(
            auth=(nc_username, app_password),
            transport=transport,
            timeout=httpx.Timeout(30.0),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    # -- plumbing ------------------------------------------------------------

    def _url(self, path: str) -> str:
        """Server hrefs (already under the DAV base path) and engine-relative
        paths both resolve to absolute URLs."""
        if path.startswith(self._base_path + "/"):
            return self._origin + path
        return self._origin + self._base_path + path

    def home_path(self) -> str:
        """The user's calendar home (Nextcloud convention)."""
        return f"/calendars/{quote(self.nc_username, safe='')}/"

    def list_path(self, list_id: str) -> str:
        return f"{self.home_path()}{quote(list_id, safe='')}/"

    def object_path(self, list_id: str, uid: str) -> str:
        return f"{self.list_path(list_id)}{quote(uid, safe='')}.ics"

    @staticmethod
    def list_id_from_href(href: str) -> str:
        """Last path segment of a collection href = the List id."""
        return unquote(href.rstrip("/").rsplit("/", 1)[-1])

    @staticmethod
    def uid_hint_from_href(href: str) -> str:
        """Object filename minus ``.ics`` — equals UID for objects this app
        (and, in practice, Apple/Nextcloud) creates; used for delete tombstones
        where the body is gone."""
        name = unquote(href.rstrip("/").rsplit("/", 1)[-1])
        return name.removesuffix(".ics")

    async def _request(
        self,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        content: bytes | None = None,
    ) -> httpx.Response:
        response = await self._client.request(
            method, self._url(path), headers=headers or {}, content=content
        )
        if response.status_code == 401:
            raise CalDAVUnauthorized(f"{method} {path}: Nextcloud rejected the credentials")
        return response

    @staticmethod
    def _multistatus(response: httpx.Response) -> ElementTree.Element:
        try:
            return ElementTree.fromstring(response.content)
        except ElementTree.ParseError as exc:
            raise CalDAVError(f"unparseable multistatus response: {exc}") from exc

    # -- onboarding ----------------------------------------------------------

    async def validate_credentials(self) -> bool:
        """Live PROPFIND for the current-user principal — Onboarding's check."""
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop>'
            "</d:propfind>"
        ).encode()
        try:
            response = await self._request(
                "PROPFIND",
                "/",
                headers={"Depth": "0", "Content-Type": "application/xml; charset=utf-8"},
                content=body,
            )
        except CalDAVUnauthorized:
            return False
        if response.status_code != 207:
            raise CalDAVError(f"principal PROPFIND failed: HTTP {response.status_code}")
        root = self._multistatus(response)
        principal = root.find(".//d:current-user-principal/d:href", _NS)
        return principal is not None and bool(_text(principal).strip())

    # -- lists ---------------------------------------------------------------

    async def list_task_lists(self) -> list[ListInfo]:
        """All VTODO-capable calendar collections in the user's home."""
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            "<d:prop><d:resourcetype/><d:displayname/>"
            "<c:supported-calendar-component-set/></d:prop></d:propfind>"
        ).encode()
        response = await self._request(
            "PROPFIND",
            self.home_path(),
            headers={"Depth": "1", "Content-Type": "application/xml; charset=utf-8"},
            content=body,
        )
        if response.status_code != 207:
            raise CalDAVError(f"calendar-home PROPFIND failed: HTTP {response.status_code}")
        lists: list[ListInfo] = []
        for resp in self._multistatus(response).findall("d:response", _NS):
            href = _text(resp.find("d:href", _NS)).strip()
            if not href:
                continue
            resourcetype = resp.find(".//d:propstat/d:prop/d:resourcetype", _NS)
            if resourcetype is None or resourcetype.find("c:calendar", _NS) is None:
                continue
            components = resp.findall(
                ".//d:propstat/d:prop/c:supported-calendar-component-set/c:comp", _NS
            )
            supported = {comp.get("name", "").upper() for comp in components}
            if supported and "VTODO" not in supported:
                continue
            list_id = self.list_id_from_href(href)
            name = _text(resp.find(".//d:propstat/d:prop/d:displayname", _NS)).strip()
            lists.append(ListInfo(id=list_id, href=href, name=name or list_id))
        return sorted(lists, key=lambda li: li.id)

    async def create_list(self, list_id: str, name: str) -> None:
        """MKCALENDAR a VTODO collection; conflict → :class:`CalDAVAlreadyExists`."""
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            "<d:set><d:prop>"
            f"<d:displayname>{escape(name)}</d:displayname>"
            '<c:supported-calendar-component-set><c:comp name="VTODO"/>'
            "</c:supported-calendar-component-set>"
            "</d:prop></d:set></c:mkcalendar>"
        ).encode()
        response = await self._request(
            "MKCALENDAR",
            self.list_path(list_id),
            headers={"Content-Type": "application/xml; charset=utf-8"},
            content=body,
        )
        if response.status_code == 405:
            raise CalDAVAlreadyExists(f"list {list_id!r} already exists")
        if response.status_code not in (201, 204):
            raise CalDAVError(f"MKCALENDAR {list_id!r} failed: HTTP {response.status_code}")

    async def rename_list(self, list_id: str, name: str) -> None:
        """PROPPATCH the displayname."""
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<d:propertyupdate xmlns:d="DAV:"><d:set><d:prop>'
            f"<d:displayname>{escape(name)}</d:displayname>"
            "</d:prop></d:set></d:propertyupdate>"
        ).encode()
        response = await self._request(
            "PROPPATCH",
            self.list_path(list_id),
            headers={"Content-Type": "application/xml; charset=utf-8"},
            content=body,
        )
        if response.status_code == 404:
            raise CalDAVNotFound(f"list {list_id!r} not found")
        if response.status_code not in (200, 207):
            raise CalDAVError(f"PROPPATCH {list_id!r} failed: HTTP {response.status_code}")
        status = _text(self._multistatus(response).find(".//d:propstat/d:status", _NS))
        if "200" not in status:
            raise CalDAVError(f"PROPPATCH {list_id!r} rejected: {status or 'no status'}")

    async def delete_list(self, list_id: str) -> None:
        """DELETE the collection (Nextcloud keeps it in the calendar trashbin)."""
        response = await self._request("DELETE", self.list_path(list_id))
        if response.status_code == 404:
            raise CalDAVNotFound(f"list {list_id!r} not found")
        if response.status_code not in (200, 204):
            raise CalDAVError(f"DELETE list {list_id!r} failed: HTTP {response.status_code}")

    # -- sync ----------------------------------------------------------------

    async def get_sync_token(self, list_href: str) -> str:
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<d:propfind xmlns:d="DAV:"><d:prop><d:sync-token/></d:prop></d:propfind>'
        ).encode()
        response = await self._request(
            "PROPFIND",
            list_href,
            headers={"Depth": "0", "Content-Type": "application/xml; charset=utf-8"},
            content=body,
        )
        if response.status_code == 404:
            raise CalDAVNotFound(f"list {list_href!r} not found")
        if response.status_code != 207:
            raise CalDAVError(f"sync-token PROPFIND failed: HTTP {response.status_code}")
        token = _text(self._multistatus(response).find(".//d:propstat/d:prop/d:sync-token", _NS))
        if not token:
            raise CalDAVError(f"list {list_href!r} exposes no sync-token")
        return token.strip()

    async def fetch_all_tasks(self, list_href: str) -> list[ObjectState]:
        """Full calendar-query REPORT for every VTODO in the List."""
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            "<d:prop><d:getetag/><c:calendar-data/></d:prop>"
            '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/>'
            "</c:comp-filter></c:filter></c:calendar-query>"
        ).encode()
        response = await self._request(
            "REPORT",
            list_href,
            headers={"Depth": "1", "Content-Type": "application/xml; charset=utf-8"},
            content=body,
        )
        if response.status_code == 404:
            raise CalDAVNotFound(f"list {list_href!r} not found")
        if response.status_code != 207:
            raise CalDAVError(f"calendar-query REPORT failed: HTTP {response.status_code}")
        return self._parse_object_states(self._multistatus(response))

    async def sync_delta(self, list_href: str, sync_token: str) -> DeltaResult:
        """RFC 6578 sync-collection REPORT + multiget of the changed objects.

        Raises :class:`CalDAVSyncTokenInvalid` when the server no longer
        accepts the token (callers restart with a full snapshot).
        """
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<d:sync-collection xmlns:d="DAV:">'
            f"<d:sync-token>{escape(sync_token)}</d:sync-token>"
            "<d:sync-level>1</d:sync-level>"
            "<d:prop><d:getetag/></d:prop></d:sync-collection>"
        ).encode()
        response = await self._request(
            "REPORT",
            list_href,
            headers={"Content-Type": "application/xml; charset=utf-8"},
            content=body,
        )
        if response.status_code == 404:
            raise CalDAVNotFound(f"list {list_href!r} not found")
        if response.status_code in (400, 403, 409):
            # sabre/Nextcloud reports an expired/foreign token as 403 with a
            # DAV:valid-sync-token precondition; treat the family as invalid.
            raise CalDAVSyncTokenInvalid(
                f"sync-token rejected for {list_href!r}: HTTP {response.status_code}"
            )
        if response.status_code != 207:
            raise CalDAVError(f"sync-collection REPORT failed: HTTP {response.status_code}")

        root = self._multistatus(response)
        changed_hrefs: list[str] = []
        removed_hrefs: list[str] = []
        for resp in root.findall("d:response", _NS):
            href = _text(resp.find("d:href", _NS)).strip()
            if not href or href.rstrip("/") == list_href.rstrip("/"):
                continue
            status = _text(resp.find("d:status", _NS))
            if "404" in status:
                removed_hrefs.append(href)
            else:
                changed_hrefs.append(href)
        new_token = _text(root.find("d:sync-token", _NS)).strip()
        if not new_token:
            raise CalDAVError(f"sync-collection response for {list_href!r} lacks a sync-token")
        changed = await self.multiget(list_href, changed_hrefs) if changed_hrefs else []
        return DeltaResult(changed=changed, removed_hrefs=removed_hrefs, sync_token=new_token)

    async def multiget(self, list_href: str, hrefs: list[str]) -> list[ObjectState]:
        href_xml = "".join(f"<d:href>{escape(h)}</d:href>" for h in hrefs)
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            f"<d:prop><d:getetag/><c:calendar-data/></d:prop>{href_xml}"
            "</c:calendar-multiget>"
        ).encode()
        response = await self._request(
            "REPORT",
            list_href,
            headers={"Depth": "1", "Content-Type": "application/xml; charset=utf-8"},
            content=body,
        )
        if response.status_code != 207:
            raise CalDAVError(f"calendar-multiget REPORT failed: HTTP {response.status_code}")
        return self._parse_object_states(self._multistatus(response))

    def _parse_object_states(self, root: ElementTree.Element) -> list[ObjectState]:
        states: list[ObjectState] = []
        for resp in root.findall("d:response", _NS):
            href = _text(resp.find("d:href", _NS)).strip()
            data = resp.find(".//d:propstat/d:prop/c:calendar-data", _NS)
            etag = _text(resp.find(".//d:propstat/d:prop/d:getetag", _NS)).strip()
            if not href or data is None or not (data.text or "").strip():
                continue
            states.append(ObjectState(href=href, etag=etag, ics=(data.text or "").encode()))
        return states

    # -- objects -------------------------------------------------------------

    async def get_object(self, href: str) -> ObjectState:
        response = await self._request("GET", href)
        if response.status_code == 404:
            raise CalDAVNotFound(f"object {href!r} not found")
        if response.status_code != 200:
            raise CalDAVError(f"GET {href!r} failed: HTTP {response.status_code}")
        return ObjectState(
            href=href, etag=response.headers.get("ETag", ""), ics=response.content
        )

    async def find_task(self, list_href: str, uid: str) -> ObjectState | None:
        """Locate a VTODO by UID: try the ``<uid>.ics`` convention, then a
        UID-filtered calendar-query (objects created by other clients may use
        any filename)."""
        direct = f"{list_href.rstrip('/')}/{quote(uid, safe='')}.ics"
        try:
            return await self.get_object(direct)
        except CalDAVNotFound:
            pass
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            "<d:prop><d:getetag/><c:calendar-data/></d:prop>"
            '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO">'
            '<c:prop-filter name="UID"><c:text-match collation="i;octet">'
            f"{escape(uid)}</c:text-match></c:prop-filter>"
            "</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>"
        ).encode()
        response = await self._request(
            "REPORT",
            list_href,
            headers={"Depth": "1", "Content-Type": "application/xml; charset=utf-8"},
            content=body,
        )
        if response.status_code == 404:
            raise CalDAVNotFound(f"list {list_href!r} not found")
        if response.status_code != 207:
            raise CalDAVError(f"UID calendar-query failed: HTTP {response.status_code}")
        states = self._parse_object_states(self._multistatus(response))
        return states[0] if states else None

    async def put_object(
        self,
        href: str,
        ics: bytes,
        *,
        if_match: str | None = None,
        if_none_match: bool = False,
    ) -> None:
        headers = {"Content-Type": "text/calendar; charset=utf-8"}
        if if_match:
            headers["If-Match"] = if_match
        if if_none_match:
            headers["If-None-Match"] = "*"
        response = await self._request("PUT", href, headers=headers, content=ics)
        if response.status_code == 412:
            raise CalDAVPreconditionFailed(f"PUT {href!r}: precondition failed")
        if response.status_code == 404:
            raise CalDAVNotFound(f"PUT {href!r}: parent collection not found")
        if response.status_code not in (200, 201, 204):
            raise CalDAVError(f"PUT {href!r} failed: HTTP {response.status_code}")

    async def delete_object(self, href: str, *, if_match: str | None = None) -> None:
        headers: dict[str, str] = {}
        if if_match:
            headers["If-Match"] = if_match
        response = await self._request("DELETE", href, headers=headers)
        if response.status_code == 412:
            raise CalDAVPreconditionFailed(f"DELETE {href!r}: precondition failed")
        if response.status_code == 404:
            raise CalDAVNotFound(f"object {href!r} not found")
        if response.status_code not in (200, 204):
            raise CalDAVError(f"DELETE {href!r} failed: HTTP {response.status_code}")
