# tasks — design (grilled 2026-07-03)

**Status:** Approved via /grill-with-docs interview (all decisions Viktor's)
**Why this exists:** Apple Reminders permanently stopped writing to CalDAV (account-level
"upgrade", falsified all recovery paths 2026-06→07). Nextcloud stays the source of truth;
this app replaces the Reminders front-end. Glossary: `CONTEXT.md`. Key decisions:
`docs/adr/0001`, `docs/adr/0002`.

## Decisions (locked)

| # | Question | Decision |
|---|----------|----------|
| 1 | Where it lives | New standalone sub-project `~/code/tasks` (agent service `nextcloud-todos` stays untouched; its docs scope it as reactive-only) |
| 2 | Users | Multi-user day 1: Viktor, Anca, Emo (all have Nextcloud accounts) |
| 3 | Gate | Authentik forward-auth (`ingress_factory auth="required"`), identity via `X-authentik-username` |
| 4 | Hostname | `tasks.viktorbarzin.me` (proxied, auto-DNS) |
| 5 | Credentials | Self-service Onboarding; encrypted per-user NC app passwords in own DB (ADR-0002) |
| 6 | Offline | Full offline-first: complete Replica (everything, always), Op Queue, Silent LWW (ADR-0001) |
| 7 | Sync API | JSON delta-sync (cursor) between PWA and proxy; proxy alone speaks CalDAV |
| 8 | Recurrence | Honor + preserve (RRULE/VALARM untouched on edit); Completion rolls Due forward via dateutil.rrule; NO rule creation/editing in v1 (62 live recurring tasks demand correct completion) |
| 9 | Views | Smart Views: Today, Scheduled, All + per-List; client-computed |
| 10 | Lists | Full CRUD incl. rename/delete (confirm dialog; NC calendar trashbin = recoverable) |
| 11 | Alerts | None in v1 (visual due/overdue only). Web-push is the designated v2 feature |
| 12 | Subtasks/tags/flags | Out of scope v1 (live data: zero subtask relations) |
| 13 | Stack | SvelteKit/TS static PWA + FastAPI backend (python caldav/icalendar/dateutil — best RRULE engine); single container serving SPA + API |
| 14 | Name/versioning | `tasks`, ghcr.io/viktorbarzin/tasks (public), semver from v0.1.0 |
| 15 | Process | This design → multi-agent Workflow build in vertical slices; Viktor reviews at the end |

## Architecture

```
iPhone/desktop PWA (SvelteKit, IndexedDB Replica + Op Queue, service worker)
        │  JSON delta-sync: GET /sync?cursor=…  POST /ops [batch]
        ▼
FastAPI backend (single container; serves SPA statics + API)
  ├─ auth: trusts X-authentik-username (Authentik forward-auth at Traefik)
  ├─ Connected Accounts: Postgres `tasks` DB (CNPG pg-cluster), Fernet key from Vault
  ├─ CalDAV engine: hand-rolled DAV over httpx per user (their app password) — not
  │   python-caldav, so tests mock the wire via a swappable httpx transport — with
  │   sync-tokens per List, ETag-checked writes, ICS ↔ JSON mapping (icalendar),
  │   RRULE roll-forward (dateutil)
  └─ delta cursor = opaque blob wrapping per-List CalDAV sync-tokens
        │  CalDAV (https, app passwords)
        ▼
Nextcloud (source of truth; oc_calendarobjects VTODOs; trashbin safety net)
```

## Data mapping (Task ↔ VTODO)

| App field | ICS | Notes |
|---|---|---|
| title | SUMMARY | required |
| notes | DESCRIPTION | preserve unknown props on rewrite |
| due | DUE (DATE or DATE-TIME) | all-day vs timed both supported |
| priority | PRIORITY 0/9/5/1 | None/Low/Med/High (Apple mapping) |
| completed | STATUS/COMPLETED/PERCENT-COMPLETE | recurring → roll-forward |
| list | parent collection | move = delete+create (UID preserved) |
| uid | UID | client-generated on create (idempotent replay) |

Rewrites must round-trip unknown properties (VALARM, RRULE, X-APPLE-*, CREATED…) —
parse-modify-serialize, never template-regenerate.

## v1 scope

Onboarding flow; list sidebar (accounts fixed to self); Smart Views Today/Scheduled/All;
per-List view; task create/edit sheet (title, notes, due date/time, priority, list);
complete/uncomplete with recurring roll-forward; move between lists; List CRUD;
client-side search over Replica; overdue highlighting; pull-to-refresh + background sync;
iOS 26 PWA shell per TripIt conventions (dvh, safe-area insets, inner scroller,
vite-pwa autoupdate).

Out of scope v1: alerts/push, recurrence editing, subtasks, tags/flags, sharing,
attachments, Siri.

## Interactions with existing systems

- Creating a Task in Viktor's Personal list fires the existing `webhook_listeners` →
  nextcloud-todos agent flow (desired, unchanged).
- The agent's own broken sweep (memory #6174: pool_pre_ping + suppressed errors) is a
  SEPARATE fix, not part of this project.
- Infra: new stack `infra/stacks/tasks` via ingress_factory (auth="required",
  dns_type="proxied"); CNPG db + Vault static creds per dbaas pattern; ESO secret;
  monitoring per standard (Prometheus scrape + Uptime Kuma auto-external).
- CI/CD: GHA on GitHub mirror → ghcr public → Woodpecker deploy.yml (ADR-0002 org
  doctrine, offinfra-onboard).

## Test focus (where this app can actually break)

1. Sync engine: idempotent replay, cursor gaps, 412 LWW re-apply, offline queue drain.
2. ICS round-trip fidelity (property preservation) — golden-file tests against real
   exports from the live server.
3. Recurrence roll-forward: dateutil property tests (DUE advance, COUNT/UNTIL exhaustion
   → plain completion).
4. Onboarding validation + credential encryption.
