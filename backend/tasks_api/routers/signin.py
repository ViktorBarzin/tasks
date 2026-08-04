"""GET /api/signin — the landing page for the popup re-login (§I).

The PWA opens this in a popup when the SSO session has lapsed. Because it sits
under ``/api`` it is gated by forward-auth AND excluded from the service
worker's navigation handling, so the popup always reaches Traefik→Authentik:
the login runs, the session cookie is set in the browsing context that owns the
app, and the popup lands here. Reaching this page IS the proof of a session, so
it only has to close itself; the opener's ``/api/me`` poll is the backstop for
browsers that refuse a scripted close.
"""

from fastapi import APIRouter, Depends
from fastapi.responses import HTMLResponse

from tasks_api.auth import current_username

router = APIRouter()

_PAGE = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Signed in</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center;
         justify-content: center; background: #111; color: #f5f5f7;
         font: 17px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
  p { margin: 0; padding: 24px; text-align: center; }
</style>
<p>Signed in — you can close this window.</p>
<script>
  // Scripted close is allowed for a script-opened window. Where it is not
  // (an in-app browser), the opener notices the live session and takes over.
  window.close();
</script>
"""


@router.get("/signin", response_class=HTMLResponse)
async def signin(_username: str = Depends(current_username)) -> HTMLResponse:
    """A tiny self-closing page — never cached, so a walled popup can't fake it."""
    return HTMLResponse(content=_PAGE, headers={"cache-control": "no-store"})
