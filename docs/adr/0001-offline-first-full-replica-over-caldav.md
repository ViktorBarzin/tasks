# Offline-first full replica with silent LWW, over a JSON delta-sync API

The app must capture and edit tasks with no connectivity (tube test), so the client keeps a
complete IndexedDB Replica of every List and Task (full history — at household scale it is
tiny) and renders only from it; all mutations are Ops in a durable Op Queue replayed in
order when online. Conflicts use Silent LWW: a replay rejected by a stale ETag (412)
refetches, re-applies the Op's fields on top, and writes back — no merge UI, because each
account effectively has one primary editor. The client never speaks CalDAV: the FastAPI
proxy exposes a JSON delta-sync API (cursor in, changes out, batched ops in) and alone
drives CalDAV sync-tokens/ETags/ICS against Nextcloud, keeping all iCal parsing in one
place (chosen over a raw DAV pass-through, which would push ICS/RRULE/ETag handling
into the browser).

Considered and rejected: online-only v1 (fails the capture-anywhere requirement Viktor
chose explicitly), offline add-queue only, manual conflict-merge UI (cost without benefit
for a household app).

Consequence: correctness lives in the sync engine (cursor handling, idempotent replay via
client-generated UIDs — same recipe as health ADR-0005; recurrence roll-forward on the
server). The UI is deliberately dumb. The engine speaks DAV directly over httpx (rather
than python-caldav) so the entire suite runs offline against a mocked transport. The
client-side offline requirement is realised by a hand-written app-shell service worker
(injectManifest via `@vite-pwa/sveltekit`, workbox-* precaching + a navigation fallback to
the SPA shell); the plugin's generated-SW `navigateFallback` did not cold-start offline on
a never-visited deep link on the current version, so it was rejected in favour of the
tripit injectManifest pattern (see the design doc's SW note).
