/**
 * Headless e2e for the built SPA (`vite preview` over adapter-static output),
 * one project per input modality — both exercising the true browser input
 * pipeline rather than synthetic DOM events:
 *
 *  - mobile-chromium-touch runs the `*-touch` specs on a touchscreen device
 *    descriptor; the touch gestures (long-press-to-lift, drag, tap,
 *    scroll-cancel) are driven at the CDP level in the specs;
 *  - desktop-chromium-mouse runs the `*-mouse` specs with the plain Playwright
 *    mouse (no touch emulation; matches `hover: hover` + `pointer: fine`) —
 *    classic press-move-release drags, no hold.
 *
 * All `/api` traffic is stubbed per-test; service workers are blocked for
 * determinism.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	testDir: './e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	retries: 0,
	reporter: [['list']],
	timeout: 30_000,
	use: {
		baseURL: 'http://127.0.0.1:4924',
		serviceWorkers: 'block',
		trace: 'retain-on-failure'
	},
	projects: [
		{
			name: 'mobile-chromium-touch',
			// Chromium descriptor (CDP touch); iPhone-ish metrics matter, engine
			// specifics are covered on the real device rig.
			use: { ...devices['Pixel 7'] },
			testMatch: /-touch\.spec\.ts$/
		},
		{
			name: 'desktop-chromium-mouse',
			// The macOS/desktop PWA shape: mouse input, fine pointer, hover.
			use: { ...devices['Desktop Chrome'] },
			testMatch: /-mouse\.spec\.ts$/
		}
	],
	webServer: {
		command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4924 --strictPort',
		url: 'http://127.0.0.1:4924',
		reuseExistingServer: !process.env.CI,
		timeout: 180_000
	}
});
