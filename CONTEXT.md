# Tasks

A self-hosted, Reminders-style tasks PWA for the household (Viktor, Anca, Emo), served at
tasks.viktorbarzin.me. Nextcloud CalDAV is the source of truth; this app is the daily
phone-first front-end that Apple Reminders can no longer be (Apple dropped CalDAV writes).

## Language

### Domain

**Task**:
A single to-do item. Maps 1:1 to a CalDAV VTODO object on Nextcloud.
_Avoid_: reminder, todo, item

**List**:
A named collection of Tasks, owned by one Nextcloud account. Maps 1:1 to a CalDAV
calendar collection that holds VTODOs. What Apple calls a "list" and Viktor calls a "directory".
_Avoid_: directory, folder, calendar, project

**Priority**:
A Task's importance: None, Low, Medium, or High. Stored as RFC 5545 PRIORITY 0, 9, 5, 1
respectively (matching Apple's mapping).
_Avoid_: urgency, importance levels other than these four

**Due**:
The deadline of a Task — either a date or an exact date-time.
_Avoid_: deadline, scheduled (Scheduled is a Smart View)

**Recurring Task**:
A Task with an RRULE. Completing it rolls Due forward to the next occurrence instead of
closing it. v1 honors and preserves rules but cannot create or edit them.

**Completion**:
Marking a Task done (STATUS:COMPLETED + COMPLETED timestamp + PERCENT-COMPLETE:100).
For a Recurring Task, Completion means roll-forward, not closure.

**Smart View**:
A computed cross-List view: Today (due or overdue today), Scheduled (has a Due, grouped
by day), All (every open Task grouped by List). Not stored anywhere; derived from the Replica.

### Sync

**Replica**:
The complete local copy of an account's Lists and Tasks (all of them, including completed
history) held in the client's IndexedDB. The app renders exclusively from the Replica.

**Op**:
A single user mutation (create/edit/complete/move/delete of a Task or List) recorded
locally with a client-generated UID, then replayed to the server in order.
_Avoid_: mutation, change, command

**Op Queue**:
The ordered, durable queue of Ops awaiting replay. Survives app restarts; drains when online.

**Delta Sync**:
The client↔server protocol: client sends a cursor, server returns everything that changed
since it (driven by CalDAV sync-tokens per List server-side). The client never speaks CalDAV.

**Silent LWW**:
The conflict policy. A replayed Op that hits a stale ETag (412) refetches the server copy,
re-applies its own field changes on top, and writes back — no conflict UI, last write wins.

### Accounts

**Connected Account**:
A household user's link between their Authentik identity and their Nextcloud account,
established by Onboarding and holding their encrypted app password.
_Avoid_: login, profile

**Onboarding**:
The self-service first-run flow where a user proves their Nextcloud credential (live CalDAV
check) before the app stores it as a Connected Account.
