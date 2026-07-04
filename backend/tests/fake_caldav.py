"""An in-memory Nextcloud/sabre CalDAV double, served through httpx.MockTransport.

Implements just enough DAV for the backend: Basic auth, principal PROPFIND,
calendar-home PROPFIND, sync-collection / calendar-query / calendar-multiget
REPORTs, object GET/PUT/DELETE with ETag preconditions, MKCALENDAR and
PROPPATCH. Sync-tokens follow sabre's monotonic-counter style and are
validated, so expired/foreign tokens 403 exactly like production.

Test hooks:
- ``add_after_get_hook(filename, fn)`` — run ``fn`` once after the next GET of
  that object (inject a concurrent edit between an engine's GET and PUT to
  force the 412 → Silent-LWW path).
- ``put_ics`` / ``delete_ics`` / ``get_object`` — mutate/read state directly,
  as "another client" (Apple, Nextcloud web) would.
"""

import base64
from collections.abc import Callable
from dataclasses import dataclass, field
from xml.etree import ElementTree
from xml.sax.saxutils import escape

import httpx

BASE_PATH = "/remote.php/dav"

_NS = {
    "d": "DAV:",
    "c": "urn:ietf:params:xml:ns:caldav",
    "a": "http://apple.com/ns/ical/",
    "vb": "urn:viktorbarzin:tasks",
}


@dataclass
class FakeObject:
    ics: bytes
    etag: str


@dataclass
class FakeCalendar:
    displayname: str
    components: frozenset[str] = frozenset({"VTODO"})
    #: Apple calendar-order property; None = unset (like a fresh Nextcloud calendar).
    order: int | None = None
    #: This app's ``{urn:viktorbarzin:tasks}sort-mode`` dead property; the real
    #: sabre stores ANY string a PROPPATCH sends (validation is app-side), so
    #: the fake does too. None = unset.
    sort_mode: str | None = None
    objects: dict[str, FakeObject] = field(default_factory=dict)
    version: int = 0
    # filename -> (version at last change, deleted?)
    changes: dict[str, tuple[int, bool]] = field(default_factory=dict)

    def bump(self, filename: str, deleted: bool) -> None:
        self.version += 1
        self.changes[filename] = (self.version, deleted)


class FakeNextcloud:
    """State + request handler. Wrap with ``httpx.MockTransport(fake.handler)``."""

    def __init__(self) -> None:
        self.users: dict[str, str] = {}
        self.calendars: dict[str, dict[str, FakeCalendar]] = {}
        self._etag_counter = 0
        self._after_get_hooks: dict[str, Callable[[], None]] = {}
        self.requests: list[tuple[str, str]] = []  # (method, path) audit trail

    # -- state manipulation (tests act as "another client") -------------------

    def add_user(self, username: str, password: str) -> None:
        self.users[username] = password
        self.calendars.setdefault(username, {})

    def add_calendar(
        self, username: str, cal_id: str, displayname: str, components: set[str] | None = None
    ) -> None:
        self.calendars[username][cal_id] = FakeCalendar(
            displayname=displayname,
            components=frozenset(components or {"VTODO"}),
        )

    def _next_etag(self) -> str:
        self._etag_counter += 1
        return f'"etag-{self._etag_counter}"'

    def put_ics(self, username: str, cal_id: str, filename: str, ics: bytes) -> None:
        cal = self.calendars[username][cal_id]
        cal.objects[filename] = FakeObject(ics=ics, etag=self._next_etag())
        cal.bump(filename, deleted=False)

    def delete_ics(self, username: str, cal_id: str, filename: str) -> None:
        cal = self.calendars[username][cal_id]
        del cal.objects[filename]
        cal.bump(filename, deleted=True)

    def get_object(self, username: str, cal_id: str, filename: str) -> FakeObject:
        return self.calendars[username][cal_id].objects[filename]

    def add_after_get_hook(self, filename: str, hook: Callable[[], None]) -> None:
        self._after_get_hooks[filename] = hook

    # -- helpers ---------------------------------------------------------------

    @staticmethod
    def _cal_href(username: str, cal_id: str) -> str:
        return f"{BASE_PATH}/calendars/{username}/{cal_id}/"

    @staticmethod
    def _sync_token(username: str, cal_id: str, version: int) -> str:
        return f"http://fake.local/ns/sync/{username}/{cal_id}/{version}"

    def _parse_sync_token(self, token: str, username: str, cal_id: str) -> int | None:
        prefix = f"http://fake.local/ns/sync/{username}/{cal_id}/"
        if not token.startswith(prefix):
            return None
        try:
            version = int(token[len(prefix) :])
        except ValueError:
            return None
        cal = self.calendars[username][cal_id]
        if version > cal.version:
            return None
        return version

    def _authed_user(self, request: httpx.Request) -> str | None:
        header = request.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return None
        try:
            decoded = base64.b64decode(header.removeprefix("Basic ")).decode()
            username, _, password = decoded.partition(":")
        except ValueError:
            return None
        if self.users.get(username) != password:
            return None
        return username

    @staticmethod
    def _xml(status_code: int, body: str) -> httpx.Response:
        return httpx.Response(
            status_code,
            content=body.encode(),
            headers={"Content-Type": "application/xml; charset=utf-8"},
        )

    # -- the transport handler ---------------------------------------------------

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.requests.append((request.method, path))
        if not path.startswith(BASE_PATH):
            return httpx.Response(404)
        user = self._authed_user(request)
        if user is None:
            return httpx.Response(401, content=b"Unauthorised")

        rel = path.removeprefix(BASE_PATH).rstrip("/")
        segments = [s for s in rel.split("/") if s]

        if request.method == "PROPFIND":
            return self._propfind(request, user, segments)
        if request.method == "REPORT":
            return self._report(request, user, segments)
        if request.method == "MKCALENDAR":
            return self._mkcalendar(request, user, segments)
        if request.method == "PROPPATCH":
            return self._proppatch(request, user, segments)
        if request.method == "GET":
            return self._get(user, segments)
        if request.method == "PUT":
            return self._put(request, user, segments)
        if request.method == "DELETE":
            return self._delete(request, user, segments)
        return httpx.Response(405)

    # -- PROPFIND ---------------------------------------------------------------

    def _propfind(
        self, request: httpx.Request, user: str, segments: list[str]
    ) -> httpx.Response:
        if not segments:  # DAV root → principal discovery
            body = f"""<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>{BASE_PATH}/</d:href><d:propstat><d:prop>
  <d:current-user-principal><d:href>{BASE_PATH}/principals/users/{escape(user)}/</d:href></d:current-user-principal>
 </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"""
            return self._xml(207, body)

        if len(segments) == 2 and segments[0] == "calendars":
            owner = segments[1]
            if owner != user:
                return httpx.Response(403)
            responses = [
                f"""<d:response><d:href>{BASE_PATH}/calendars/{escape(owner)}/</d:href>
<d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop>
<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"""
            ]
            for cal_id, cal in self.calendars[owner].items():
                comps = "".join(f'<c:comp name="{escape(c)}"/>' for c in sorted(cal.components))
                # sabre reports unset properties under a 404 propstat (empty
                # elements); set ones ride in the 200 block. Verified live for
                # both calendar-order and the custom sort-mode dead property.
                set_xml = ""
                unset_xml = ""
                if cal.order is not None:
                    set_xml += f"\n <a:calendar-order>{cal.order}</a:calendar-order>"
                else:
                    unset_xml += "<a:calendar-order/>"
                if cal.sort_mode is not None:
                    set_xml += f"\n <vb:sort-mode>{escape(cal.sort_mode)}</vb:sort-mode>"
                else:
                    unset_xml += "<vb:sort-mode/>"
                not_found = (
                    f"<d:propstat><d:prop>{unset_xml}</d:prop>"
                    "<d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>"
                    if unset_xml
                    else ""
                )
                responses.append(
                    f"""<d:response><d:href>{self._cal_href(owner, cal_id)}</d:href>
<d:propstat><d:prop>
 <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
 <d:displayname>{escape(cal.displayname)}</d:displayname>{set_xml}
 <c:supported-calendar-component-set>{comps}</c:supported-calendar-component-set>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>{not_found}</d:response>"""
                )
            body = (
                '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" '
                'xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/" '
                'xmlns:vb="urn:viktorbarzin:tasks">'
                + "".join(responses)
                + "</d:multistatus>"
            )
            return self._xml(207, body)

        if len(segments) == 3 and segments[0] == "calendars":
            owner, cal_id = segments[1], segments[2]
            if owner != user:
                return httpx.Response(403)
            calendar = self.calendars[owner].get(cal_id)
            if calendar is None:
                return httpx.Response(404)
            token = self._sync_token(owner, cal_id, calendar.version)
            body = f"""<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
 <d:response><d:href>{self._cal_href(owner, cal_id)}</d:href><d:propstat><d:prop>
  <d:sync-token>{escape(token)}</d:sync-token>
  <d:displayname>{escape(calendar.displayname)}</d:displayname>
 </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"""
            return self._xml(207, body)

        return httpx.Response(404)

    # -- REPORT -------------------------------------------------------------------

    def _report(self, request: httpx.Request, user: str, segments: list[str]) -> httpx.Response:
        if len(segments) != 3 or segments[0] != "calendars":
            return httpx.Response(404)
        owner, cal_id = segments[1], segments[2]
        if owner != user:
            return httpx.Response(403)
        cal = self.calendars[owner].get(cal_id)
        if cal is None:
            return httpx.Response(404)
        try:
            root = ElementTree.fromstring(request.content)
        except ElementTree.ParseError:
            return httpx.Response(400)
        tag = root.tag

        if tag == "{DAV:}sync-collection":
            return self._report_sync(root, owner, cal_id, cal)
        if tag == "{urn:ietf:params:xml:ns:caldav}calendar-query":
            return self._report_query(root, owner, cal_id, cal)
        if tag == "{urn:ietf:params:xml:ns:caldav}calendar-multiget":
            return self._report_multiget(root, owner, cal_id, cal)
        return httpx.Response(400)

    def _object_response(self, owner: str, cal_id: str, filename: str, obj: FakeObject) -> str:
        return f"""<d:response><d:href>{self._cal_href(owner, cal_id)}{escape(filename)}</d:href>
<d:propstat><d:prop><d:getetag>{escape(obj.etag)}</d:getetag>
<c:calendar-data>{escape(obj.ics.decode())}</c:calendar-data>
</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"""

    def _report_sync(
        self, root: ElementTree.Element, owner: str, cal_id: str, cal: FakeCalendar
    ) -> httpx.Response:
        token_text = (root.findtext("d:sync-token", default="", namespaces=_NS) or "").strip()
        since = self._parse_sync_token(token_text, owner, cal_id) if token_text else 0
        if since is None:
            # sabre: 403 + DAV:valid-sync-token precondition
            return self._xml(
                403,
                '<?xml version="1.0"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>',
            )
        responses = []
        for filename, (version, deleted) in sorted(cal.changes.items()):
            if version <= since:
                continue
            href = f"{self._cal_href(owner, cal_id)}{escape(filename)}"
            if deleted:
                responses.append(
                    f"<d:response><d:href>{href}</d:href>"
                    "<d:status>HTTP/1.1 404 Not Found</d:status></d:response>"
                )
            else:
                obj = cal.objects[filename]
                responses.append(
                    f"<d:response><d:href>{href}</d:href><d:propstat><d:prop>"
                    f"<d:getetag>{escape(obj.etag)}</d:getetag></d:prop>"
                    "<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>"
                )
        new_token = self._sync_token(owner, cal_id, cal.version)
        body = (
            '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:">'
            + "".join(responses)
            + f"<d:sync-token>{escape(new_token)}</d:sync-token></d:multistatus>"
        )
        return self._xml(207, body)

    @staticmethod
    def _has_uid(ics: bytes, uid: str) -> bool:
        unfolded = ics.replace(b"\r\n ", b"").replace(b"\r\n\t", b"")
        return f"UID:{uid}".encode() in [
            line.strip() for line in unfolded.replace(b"\r\n", b"\n").split(b"\n")
        ]

    def _report_query(
        self, root: ElementTree.Element, owner: str, cal_id: str, cal: FakeCalendar
    ) -> httpx.Response:
        uid_filter = None
        match = root.find(
            ".//c:comp-filter[@name='VTODO']/c:prop-filter[@name='UID']/c:text-match", _NS
        )
        if match is not None:
            uid_filter = (match.text or "").strip()
        responses = []
        for filename, obj in sorted(cal.objects.items()):
            if b"BEGIN:VTODO" not in obj.ics:
                continue
            if uid_filter is not None and not self._has_uid(obj.ics, uid_filter):
                continue
            responses.append(self._object_response(owner, cal_id, filename, obj))
        body = (
            '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" '
            'xmlns:c="urn:ietf:params:xml:ns:caldav">'
            + "".join(responses)
            + "</d:multistatus>"
        )
        return self._xml(207, body)

    def _report_multiget(
        self, root: ElementTree.Element, owner: str, cal_id: str, cal: FakeCalendar
    ) -> httpx.Response:
        responses = []
        for href_el in root.findall("d:href", _NS):
            href = (href_el.text or "").strip()
            filename = href.rstrip("/").rsplit("/", 1)[-1]
            obj = cal.objects.get(filename)
            if obj is None:
                responses.append(
                    f"<d:response><d:href>{escape(href)}</d:href>"
                    "<d:status>HTTP/1.1 404 Not Found</d:status></d:response>"
                )
            else:
                responses.append(self._object_response(owner, cal_id, filename, obj))
        body = (
            '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" '
            'xmlns:c="urn:ietf:params:xml:ns:caldav">'
            + "".join(responses)
            + "</d:multistatus>"
        )
        return self._xml(207, body)

    # -- collection + object methods ------------------------------------------------

    def _mkcalendar(
        self, request: httpx.Request, user: str, segments: list[str]
    ) -> httpx.Response:
        if len(segments) != 3 or segments[0] != "calendars" or segments[1] != user:
            return httpx.Response(403)
        cal_id = segments[2]
        if cal_id in self.calendars[user]:
            return httpx.Response(405)
        displayname = cal_id
        if request.content:
            try:
                root = ElementTree.fromstring(request.content)
                name_el = root.find(".//d:displayname", _NS)
                if name_el is not None and name_el.text:
                    displayname = name_el.text
            except ElementTree.ParseError:
                return httpx.Response(400)
        self.add_calendar(user, cal_id, displayname)
        return httpx.Response(201)

    def _proppatch(
        self, request: httpx.Request, user: str, segments: list[str]
    ) -> httpx.Response:
        if len(segments) != 3 or segments[0] != "calendars" or segments[1] != user:
            return httpx.Response(403)
        cal = self.calendars[user].get(segments[2])
        if cal is None:
            return httpx.Response(404)
        try:
            root = ElementTree.fromstring(request.content)
        except ElementTree.ParseError:
            return httpx.Response(400)
        set_props: list[str] = []
        name_el = root.find(".//d:set/d:prop/d:displayname", _NS)
        if name_el is not None:
            cal.displayname = name_el.text or ""
            set_props.append("<d:displayname/>")
        order_el = root.find(".//d:set/d:prop/a:calendar-order", _NS)
        if order_el is not None:
            try:
                cal.order = int((order_el.text or "").strip())
            except ValueError:
                return httpx.Response(400)
            set_props.append("<a:calendar-order/>")
        sort_mode_el = root.find(".//d:set/d:prop/vb:sort-mode", _NS)
        if sort_mode_el is not None:
            # A dead property: sabre stores whatever string arrives (verified
            # live) — value validation is the app server's job, not DAV's.
            cal.sort_mode = sort_mode_el.text or ""
            set_props.append("<vb:sort-mode/>")
        if not set_props:
            return httpx.Response(400)
        body = f"""<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:a="http://apple.com/ns/ical/" xmlns:vb="urn:viktorbarzin:tasks">
 <d:response><d:href>{self._cal_href(user, segments[2])}</d:href>
  <d:propstat><d:prop>{''.join(set_props)}</d:prop>
  <d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>"""
        return self._xml(207, body)

    def _locate(
        self, user: str, segments: list[str]
    ) -> tuple[str, FakeCalendar, str] | httpx.Response:
        if len(segments) != 4 or segments[0] != "calendars":
            return httpx.Response(404)
        if segments[1] != user:
            return httpx.Response(403)
        cal = self.calendars[user].get(segments[2])
        if cal is None:
            return httpx.Response(404)
        return segments[2], cal, segments[3]

    def _get(self, user: str, segments: list[str]) -> httpx.Response:
        located = self._locate(user, segments)
        if isinstance(located, httpx.Response):
            return located
        _, cal, filename = located
        obj = cal.objects.get(filename)
        if obj is None:
            return httpx.Response(404)
        response = httpx.Response(
            200,
            content=obj.ics,
            headers={"ETag": obj.etag, "Content-Type": "text/calendar; charset=utf-8"},
        )
        hook = self._after_get_hooks.pop(filename, None)
        if hook is not None:
            hook()
        return response

    def _put(self, request: httpx.Request, user: str, segments: list[str]) -> httpx.Response:
        located = self._locate(user, segments)
        if isinstance(located, httpx.Response):
            return located
        cal_id, cal, filename = located
        existing = cal.objects.get(filename)
        if request.headers.get("If-None-Match") == "*" and existing is not None:
            return httpx.Response(412)
        if_match = request.headers.get("If-Match")
        if if_match is not None and (existing is None or existing.etag != if_match):
            return httpx.Response(412)
        self.put_ics(user, cal_id, filename, request.content)
        return httpx.Response(
            201 if existing is None else 204,
            headers={"ETag": cal.objects[filename].etag},
        )

    def _delete(self, request: httpx.Request, user: str, segments: list[str]) -> httpx.Response:
        # collection delete
        if len(segments) == 3 and segments[0] == "calendars" and segments[1] == user:
            if segments[2] not in self.calendars[user]:
                return httpx.Response(404)
            del self.calendars[user][segments[2]]
            return httpx.Response(204)
        located = self._locate(user, segments)
        if isinstance(located, httpx.Response):
            return located
        cal_id, cal, filename = located
        existing = cal.objects.get(filename)
        if existing is None:
            return httpx.Response(404)
        if_match = request.headers.get("If-Match")
        if if_match is not None and existing.etag != if_match:
            return httpx.Response(412)
        self.delete_ics(user, cal_id, filename)
        return httpx.Response(204)
