# Product events, errors and logs on the platform telemetry standard

Date: 2026-11-12. Related: infra ADR-0041 and its design
`docs/plans/2026-11-09-product-analytics-design.md`, app-kit ADR-0002 (log
fields, telemetry on by default) and ADR-0003 (packages from Forgejo).

## Context

The homelab has one telemetry standard: product events in the Segment spec
through the Ingest path, pageviews and replay from the Rybbit script, errors
in GlitchTip through the Sentry SDKs, and JSON logs with OpenTelemetry field
names. tasks ran the 0.1.0 `@viktorbarzin` packages from npm, with the old
log line (`ts`, `level`, `logger`, `msg`) and no events. Viktor asked for
every TanStack app to be wired onto the standard.

Two things about tasks shape how. Every screen renders from the IndexedDB
Replica, so most of what a person does in the UI never reaches the server.
And the page is a client-only shell that the service worker precaches and
serves offline, so anything baked into the shell is stale or missing.

## Decision

1. **Packages.** Every `@viktorbarzin` package moves to 1.0.0 and
   `@viktorbarzin/telemetry` 0.2.0 joins them, all installed from Forgejo's
   npm registry (`bunfig.toml` `[install.scopes]`).
2. **Logs.** `@viktorbarzin/log` 1.0 writes the OpenTelemetry fields to
   stdout. The Nitro plugin sets the service fields (`service.name` tasks,
   `service.version` from `SERVICE_VERSION`, which the image gets from the
   commit). Each request runs in a log context, and `handleApi` sets the
   caller's `sub` as `enduser.id`.
3. **Server events** for the core actions, with the caller's Authentik `sub`
   as `userId`:

   | Event | When | Properties |
   |---|---|---|
   | `account.connected` | `POST /api/onboard` saved a Connected Account | none |
   | `task.created` | a `task_create` op took effect | `has_due_date`, `priority` |
   | `task.completed` | a `task_complete` op took effect | none |
   | `list.created` | a `list_create` op took effect | none |

   "Took effect" means `applied` or `lww_reapplied`. Duplicates, per-op
   errors and retries send nothing, so a replayed Op Queue does not count
   twice. No event carries task titles, notes or list names.
4. **Request context.** A global request middleware runs every request in
   `withRequestContext`, so server events carry the browser's Rybbit visitor
   id (`X-Visitor-Id`), IP and User-Agent. The browser sends the visitor id
   on every `/api` call (`src/client/api.ts`) and server function call (a
   function middleware in `src/start.ts`).
5. **Browser.** `src/components/Telemetry.tsx` asks a server function for the
   settings after the page loads, never from the cached shell, then starts
   `initTelemetry` with `personId`, so `identify` runs on every signed-in
   load. Offline the call fails and the page runs without telemetry. Sentry
   loads lazily with the public DSN (`SENTRY_BROWSER_DSN`). The page carries
   `<meta name="analytics" content="sdk">` so the ingress plugin does not
   inject a second script. tasks has no sign-out, so nothing calls `reset()`.
6. **Browser events**, for actions only the page sees (`src/client/events.ts`):

   | Event | When | Properties |
   |---|---|---|
   | `smart_view.opened` | a Smart View opens | `view` |
   | `completed_tasks.toggled` | the completed section is shown or hidden | `shown` |
   | `search.started` | a search query goes from blank to non-blank | `screen` |
   | `task_sheet.opened` | the task sheet opens | `mode` (`edit`, `new`) |

7. **Configuration** comes from infra `stacks/tasks/telemetry.tf` through the
   `tanstack_app` module's `secret_env`: `TELEMETRY_WRITE_KEY`,
   `TELEMETRY_HOST` (the in-cluster pipeline), `TELEMETRY_ENVIRONMENT`,
   `SENTRY_DSN` (in-cluster GlitchTip) and `SENTRY_BROWSER_DSN`. Without a
   write key, or with `TELEMETRY=off`, nothing is sent.

## Consequences

- Loki queries for tasks read `body`, `severity_text` and `logger.name`
  instead of `msg`, `level` and `logger`.
- An image build needs `forgejo.viktorbarzin.me` reachable for `bun install`.
- Ops sent by a CLI or agent with a bearer token count as that person's
  events, without a visitor id.
- The dev user has no `sub`, so its events fall back to the visitor id or
  `server:tasks`.

## Open questions

- Whether `task.completed` should say if the task was recurring. The op does
  not carry it, and finding out costs a CalDAV read.
