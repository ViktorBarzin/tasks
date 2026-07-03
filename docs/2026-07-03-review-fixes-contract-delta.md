# tasks — review fix pass (contract delta v1.1)

Consolidated confirmed findings from the 2026-07-03 adversarial reviews (sync, security, PWA)
and the EXACT wire-contract changes that fix them. Both fixers build against this doc verbatim —
do not diverge (the task_move bug came from a loose contract). Frontend `types.ts` and backend
`schemas.py` must match this after the pass.

## A. task_move field alignment  (SYNC-1 CRITICAL, SYNC-8 minor)
Op = `{op_id, kind:"task_move", uid, list_id (SOURCE), to_list_id (DESTINATION)}`.
Client sends BOTH. Backend: dest = `to_list_id`, source hint = `list_id` (locate in source first,
so a half-done move that left a target copy doesn't shadow the source). Fix `actions.ts`+`types.ts`.

## B. Per-op result taxonomy + ordering  (SYNC-3 MAJOR, SYNC-7 minor, PWA-F2 HIGH)
- status enum: `applied | lww_reapplied | duplicate | retry | error`.
  `retry` = transient upstream (Nextcloud 5xx / timeout), op NOT applied, safe to resend.
  `error` = permanent (Nextcloud 4xx, validation, unknown kind) — never succeeds as-is.
- Batch must NOT hard-422 on one malformed op: validate per-op; a bad op → per-op `error`, not a 400/422 for the whole batch.
- Server applies IN ORDER and STOPS at the first `retry` (results = processed prefix + the stopper as `retry`; unattempted remainder omitted → client resends next cycle, order preserved). A permanent `error` is isolated (skip, continue).
- Client drain (`sync.ts`): dequeue ONLY terminal ops (applied/lww_reapplied/duplicate/error); an op that returns `retry` — and everything after it — stays queued in order. NEVER silently drop a `retry`. Remove the "drop after 5 attempts" for retryable failures. Permanent `error` → move to a dead-letter store + surface a banner ("N tasks couldn't sync"). Also surface a persistent-failure banner if retryable ops stay stuck > a few cycles.

## C. Recurring completion occurrence identity  (SYNC-4 MAJOR, SYNC-5 MAJOR)
Op = `{op_id, kind:"task_complete", uid, completed_at (ISO), occurrence_due (ISO date|datetime|null — the DUE the client saw)}`.
Server roll-forward:
- Use `completed_at` as the completion instant AND the roll-forward base — NOT replay-time `now`.
- Roll forward ONLY if the object's current DUE == `occurrence_due`. If DUE already advanced past it → already completed elsewhere → return `duplicate`, no second roll.
- Journal write atomic/IntegrityError-safe on unique `op_id` (catch IntegrityError → `duplicate`; no check-then-act race).
- Crash-safety: the occurrence_due guard + create-UID existence make a re-applied op a no-op/duplicate.

## D. Delete tombstone by true UID  (SYNC-6 MAJOR)
Delta deletion tombstones MUST carry the object's real UID (as clients store it), never a
filename-derived guess. Maintain a server-side href→UID index from REPORTs; map a deleted href to
the stored UID. This fixes Apple-legacy-named objects (filename≠UID) becoming undeletable ghosts.

## E. List-delete cascade  (SYNC-2 MAJOR)
On a List tombstone in a delta, the CLIENT fold must cascade-delete every task with that
`list_id` (mirror the local-op cascade in `db.ts`). Smart Views (`views.ts`) must also defensively
exclude tasks whose list no longer exists in the Replica.

## F. All-day recurrence in local time  (SYNC-11 minor — household is Europe/Sofia)
Roll-forward for date-valued (all-day) DUE computes "next occurrence after completed_at" in the
user's local tz. Use a fixed app default `Europe/Sofia` (single constant, config-overridable);
do not compute all-day rolls in UTC.

## G. Onboarding 422 must not echo the app password  (SEC-2 minor, CWE-209)
`errors.py`: the validation-error envelope must NOT serialize Pydantic's `input` (it contains the
submitted `app_password`). Emit field-name + message only.

## H. PWA offline cold-start  (PWA-F1 CRITICAL — the founding requirement)
Fix `vite.config.ts` so the app shell precaches and navigations fall back to it offline:
`SvelteKitPWA({ kit:{ spa:true, adapterFallback:'index.html' }, workbox:{ navigateFallback:'/',
navigateFallbackDenylist:[/^\/api\//,/^\/healthz$/,/^\/metrics$/] } })` — or adopt tripit's
injectManifest appShell SW (`tripit/frontend/src/service-worker.ts`). MUST verify: installed PWA
cold-starts offline on a NEVER-VISITED deep link (`/list/<id>`), served with no network.

## I. Auth-wall re-login path  (PWA-F3 HIGH)
`api.ts`: detect the Authentik wall — `fetch(..., {redirect:'manual'})` + treat
`response.type==='opaqueredirect'` (or a non-JSON content-type on an ok response) as a distinct
`needsLogin` state (NOT offline). Surface "Session expired — sign in" → `window.location.assign('/')`
(a full navigation reaches Traefik→Authentik). The SW denylist from (H) must let that navigation
hit the network. `Onboarding.svelte` reconnect must use the same detection (not the wrong "offline"
message).

## J. Cold-launch op-queue rebase  (PWA-F4 medium)
`loadReplica()` must re-apply pending ops onto the loaded Replica (reuse `foldServerState`'s rebase
loop) so queued edits are visible offline after a mid-write kill.

## K. SW update on resume  (PWA-F5 medium)
Add periodic `registration.update()` (hourly) + a `visibilitychange` re-check (tripit pattern in
`ReloadPrompt.svelte`/memory #7048) so installed PWAs pick up deploys instead of pinning a stale bundle.

## L. Latent contract guard  (SYNC-12 minor)
`ics_mapper` task_update: reject/normalize inconsistent due fields — `due_has_time:true` without
`due`, or a datetime `due` without `due_has_time` — instead of silently clearing DUE or erroring.

## Explicitly ACCEPTED (not fixed this pass — documented so nobody re-flags)
- SYNC-9 quick-add fold flicker (self-heals via the coalesced follow-up cycle; UI-only, ms-wide).
- SYNC-10 edge-degraded unguarded-overwrite window (inherent to the openresty conditional-write
  workaround, infra#65; ms-wide; disappears when the ingress bug is fixed).
- iOS TaskSheet 15px inputs (guarded by `maximum-scale=1`; revisit only if viewport meta changes).
- clock 60s staleness on resume (cosmetic).

## Handled in INFRA, not app code  (SEC-1 MAJOR)
NetworkPolicy restricting pod ingress to the Traefik namespace; `DEV_USER` unset in prod;
ingress `auth="required"`. These are deploy invariants for the `infra/stacks/tasks` stack.
