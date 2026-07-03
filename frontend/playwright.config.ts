/**
 * Headless touch e2e for the built SPA (`vite preview` over adapter-static
 * output). One project: mobile Chromium with a touchscreen — the real-input
 * touch gestures (long-press-to-lift, drag, tap, scroll-cancel) are driven at
 * the CDP level in the specs, exercising the true browser input pipeline
 * rather than synthetic DOM events. All `/api` traffic is stubbed per-test;
 * service workers are blocked for determinism.
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
			use: { ...devices['Pixel 7'] }
		}
	],
	webServer: {
		command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4924 --strictPort',
		url: 'http://127.0.0.1:4924',
		reuseExistingServer: !process.env.CI,
		timeout: 180_000
	}
});
