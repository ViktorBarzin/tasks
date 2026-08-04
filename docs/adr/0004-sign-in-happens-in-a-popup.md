# Sign-in happens in a popup, with the full-page path as fallback

ADR-0003 made the "Session expired — sign in" tap reach the login page at all. It reached
it by navigating the app window, which works but is heavy-handed: the app is torn down and
rebuilt, and on an installed PWA the window leaves for the SSO origin and comes back.
Viktor asked for a popup instead — sign in beside the app, keep the app.

`$lib/signin.ts` opens `/api/signin` in a popup. That target is deliberate: it sits under
`/api`, so forward-auth gates it (reaching it at all proves a fresh session) and the
service worker's navigation handler excludes it (it always goes to the network, no marker
needed). The page closes itself. The opener polls `GET /api/me` every second for up to
three minutes, because the poll is the only completion signal that survives every
browser's popup behaviour — a scripted `window.close()` can be refused, and a popup opened
outside the app's browsing context never talks back. On success the app clears the banner
and syncs; it never reloaded, so the Replica, the Op Queue and the current screen are
exactly as the user left them.

The cookie needs no help to persist: Authentik's outpost issues it with `Max-Age` ≈ 28
days, `HttpOnly`, `Secure`. The only question was ever which browsing context receives it,
which is precisely why a popup is not obviously better everywhere — see below.

Two fallbacks, because a stranded user is the failure we are fixing:

- **Popup refused** (`window.open` returns null) → the ADR-0003 full-page navigation runs
  immediately. This is why the marker and its service-worker escape hatch stay.
- **Popup ends with no session** → `signinFailed`, and the banner becomes "Sign-in didn't
  finish — sign in here", whose tap takes the full-page path. This covers the case we
  cannot detect directly: a browser that opens the popup in a *different* storage
  container, so the session it earns is invisible to the app.

That last case is the open risk on iOS. Viktor's installed PWA has its own cookie jar,
separate from Safari — verified 2026-08-02, when signing in in Safari left the installed
app still walled. If iOS also hands popups to Safari, the popup path cannot work on his
main device and the escalation above is what actually signs him in. Chromium is covered by
`e2e-sw/relogin.spec.ts` (popup round trip, blocked-popup fallback, abandoned-popup
escalation); the iOS behaviour needs the on-device rig to settle, and until it does the
popup is an enhancement for desktop/Android rather than a fix for iOS.
