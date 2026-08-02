# The re-login navigation carries a marker so it escapes the app shell

The two PWA requirements collide, and the collision locked Viktor out of the app for a
month.

§H (ADR-0001, the founding requirement) says the service worker precaches the app shell
and serves it for **every** in-scope navigation, so a never-visited deep link cold-starts
with no network. §I says the remediation for a lapsed Authentik session is a full
navigation to `/`, because only a real navigation reaches Traefik→Authentik and gets
bounced to the SSO login. Both were implemented as written. The result: tapping "Session
expired — sign in" navigated to `/`, the service worker answered it from the precache
(verified: the document response reports `fromServiceWorker: true`), Traefik was never
reached, the next sync cycle hit the wall again and the banner came straight back. There
was no way to sign in from the installed app — the only exits were deleting and re-adding
the home-screen app, or logging in to some other `viktorbarzin.me` service in a browser.

The re-login navigation now carries a marker query (`?relogin=1`, `$lib/relogin.ts`) and
the service worker's navigation handler treats a marked navigation as network-first:
`fetch(request)` so the forward-auth 302 happens, falling back to the shell if the network
throws. Everything unmarked is served from the precache exactly as before, so §H is
untouched — `e2e-sw/relogin.spec.ts` asserts both halves, including the offline deep-link
cold start it must not regress.

Alternatives rejected: adding the marker to the navigation **denylist** (simplest, but a
tap with no signal dead-ends on the browser's error page — nasty in a standalone PWA with
no address bar to escape from); making all navigations network-first (gives up the
offline-first cold start §H exists for).

Consequences: the marker is a two-place contract — `$lib/relogin.ts` and
`src/service-worker.ts` import the same constant, and the service worker imports from
`$lib` by relative path because it is bundled by vite, not SvelteKit. A device stuck on a
service worker built before this change cannot self-heal, because the SW update check is a
network request that the wall also bounces; one successful login by any means (any
`viktorbarzin.me` app in a browser, or re-adding the app) restores the session, after
which the fixed worker installs on the next update check. Sessions last `weeks=4`
(Authentik `session_duration`), so this path runs roughly monthly and is now one tap.
