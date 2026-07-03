import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		sveltekit(),
		// vite-plugin-pwa (SvelteKit integration), autoUpdate + injectManifest: a
		// hand-written app-shell service worker (src/service-worker.ts) that swaps
		// itself in on a new deploy.
		SvelteKitPWA({
			registerType: 'autoUpdate',
			// Hand-written app-shell SW so a never-visited deep link cold-starts
			// OFFLINE (§H): injectManifest precaches the shell + build assets and the
			// SW serves the shell for any in-scope navigation.
			strategies: 'injectManifest',
			srcDir: 'src',
			filename: 'service-worker.ts',
			// Registration is done manually in +layout.svelte (virtual:pwa-register).
			injectRegister: null,
			manifest: {
				name: 'Tasks',
				short_name: 'Tasks',
				description: 'Reminders-style tasks for the household, backed by Nextcloud',
				start_url: '/',
				display: 'standalone',
				background_color: '#111111',
				theme_color: '#111111',
				icons: [
					{ src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
					{ src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
					{
						src: '/pwa-512x512.png',
						sizes: '512x512',
						type: 'image/png',
						purpose: 'maskable'
					}
				]
			},
			// spa + adapterFallback ⇒ the fallback index.html is added to the
			// precache manifest (self.__WB_MANIFEST) that the SW serves as the shell.
			kit: {
				spa: true,
				adapterFallback: 'index.html'
			},
			injectManifest: {
				globPatterns: ['client/**/*.{js,css,html,svg,png,ico,webp,woff,woff2,webmanifest}']
			},
			devOptions: {
				enabled: false
			}
		})
	],
	test: {
		include: ['src/**/*.{test,spec}.{js,ts}'],
		environment: 'node'
	}
});
