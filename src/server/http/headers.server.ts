/**
 * Response headers every page and endpoint carries.
 *
 * Anti-framing (clickjacking): the ingress's default CSP allows any
 * `*.viktorbarzin.me` site to frame the app, including the multi-user
 * `pages` host, and a same-site frame gets the SameSite=Lax session cookie.
 * Nothing in the app is meant to be framed (sign-in uses a popup window).
 *
 * The ingress's CSP middleware replaces a Content-Security-Policy the app
 * sets, so the deployed ingress must also send `frame-ancestors 'none'`
 * (ingress_factory `custom_content_security_policy`; see AGENTS.md).
 */
export const FRAME_DENY_HEADERS: Readonly<Record<string, string>> = {
	"content-security-policy": "frame-ancestors 'none'",
	"x-frame-options": "DENY",
};

/** The response with the anti-framing headers set; a copy when its headers are immutable. */
export function withFrameDenial(response: Response): Response {
	try {
		for (const [name, value] of Object.entries(FRAME_DENY_HEADERS))
			if (!response.headers.has(name)) response.headers.set(name, value);
		return response;
	} catch {
		const copy = new Response(response.body, response);
		for (const [name, value] of Object.entries(FRAME_DENY_HEADERS))
			if (!copy.headers.has(name)) copy.headers.set(name, value);
		return copy;
	}
}
