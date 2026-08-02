/**
 * Service-worker e2e — a SEPARATE config from `playwright.config.ts` on purpose.
 *
 * The UI-gesture suite blocks service workers for determinism; this suite is
 * about the service worker: an installed PWA whose SW owns navigations, served
 * by the Traefik→Authentik stand-in in `e2e-sw/fixtures/auth-wall-server.mjs`
 * (its own origin pair, so `/api` stubbing via `page.route` — which does not
 * cover SW-originated requests — is not involved).
 */
import { defineConfig, devices } from '@playwright/test';

const APP_PORT = 4930;
const SSO_PORT = 4931;

export default defineConfig({
	testDir: './e2e-sw',
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: 0,
	reporter: [['list']],
	timeout: 60_000,
	use: {
		baseURL: `http://127.0.0.1:${APP_PORT}`,
		serviceWorkers: 'allow',
		trace: 'retain-on-failure'
	},
	projects: [
		{
			name: 'mobile-chromium-sw',
			// The installed-PWA shape this bug lives in (home-screen app on a phone).
			use: { ...devices['Pixel 7'] }
		}
	],
	webServer: {
		command: `npm run build && node e2e-sw/fixtures/auth-wall-server.mjs --app-port ${APP_PORT} --sso-port ${SSO_PORT}`,
		url: `http://127.0.0.1:${APP_PORT}/__test/restore`,
		reuseExistingServer: !process.env.CI,
		timeout: 180_000
	}
});
