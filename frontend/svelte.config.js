import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	kit: {
		// SPA build: everything renders client-side from the Replica; the backend
		// serves build/ with an index.html fallback (backend/tasks_api/app.py).
		adapter: adapter({
			fallback: 'index.html',
			precompress: false
		}),
		// Absolute asset/SW paths — relative paths break service-worker
		// registration on deep links (learned in tripit; see its svelte.config.js).
		paths: {
			relative: false
		}
	}
};

export default config;
