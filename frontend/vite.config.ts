import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		sveltekit(),
		// vite-plugin-pwa (SvelteKit integration), autoUpdate: the generated
		// service worker refreshes itself when a new deploy lands.
		SvelteKitPWA({
			registerType: 'autoUpdate',
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
