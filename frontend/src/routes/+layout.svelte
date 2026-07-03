<script lang="ts">
	/**
	 * The app gate. Launch order: hydrate the Replica (instant render from
	 * IndexedDB — the app must work with the network cut), then decide
	 * onboarding vs app. A device that has onboarded before goes straight in
	 * on the cached flag; /api/me is only awaited on first run. A 401 from
	 * sync later flips needsReconnect → banner → re-onboarding overlay.
	 */
	import { onMount, type Snippet } from 'svelte';
	import { pwaInfo } from 'virtual:pwa-info';

	import '../app.css';

	import { api } from '$lib/api';
	import Onboarding from '$lib/components/Onboarding.svelte';
	import * as db from '$lib/db';
	import { loadReplica } from '$lib/replica';
	import { needsReconnect, startSync, syncNow } from '$lib/sync';

	let { children }: { children: Snippet } = $props();

	let gate = $state<'loading' | 'onboard' | 'app'>('loading');
	let username = $state('');
	let showReconnect = $state(false);

	const webManifestLink = pwaInfo ? pwaInfo.webManifest.linkTag : '';

	onMount(async () => {
		if ('serviceWorker' in navigator) {
			// vite-plugin-pwa autoUpdate: the generated SW swaps itself in when a
			// new deploy lands.
			const { registerSW } = await import('virtual:pwa-register');
			registerSW({ immediate: true });
		}

		await loadReplica();
		username = (await db.getMeta<string>('username')) ?? '';

		if ((await db.getMeta<boolean>('connected')) ?? false) {
			enterApp();
			void refreshIdentity();
			return;
		}
		try {
			const me = await api.me();
			username = me.username;
			await db.setMeta('username', me.username);
			if (me.connected) {
				await db.setMeta('connected', true);
				enterApp();
			} else {
				gate = 'onboard';
			}
		} catch {
			// Unreachable server before this device ever onboarded: there is no
			// Replica to show, and onboarding needs the network anyway.
			gate = 'onboard';
		}
	});

	function enterApp(): void {
		gate = 'app';
		startSync();
	}

	/** Background /api/me probe: refresh the cached username; surface a lost
	 * Connected Account as the reconnect banner. Offline → ignore. */
	async function refreshIdentity(): Promise<void> {
		try {
			const me = await api.me();
			username = me.username;
			await db.setMeta('username', me.username);
			if (!me.connected) needsReconnect.set(true);
		} catch {
			/* offline or flaky — the Replica carries the session */
		}
	}

	async function onboarded(): Promise<void> {
		await db.setMeta('connected', true);
		needsReconnect.set(false);
		showReconnect = false;
		if (gate !== 'app') enterApp();
		else void syncNow();
	}
</script>

<svelte:head>
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- plugin-generated tag -->
	{@html webManifestLink}
</svelte:head>

<div class="app-shell">
	{#if gate === 'app'}
		{#if $needsReconnect && !showReconnect}
			<button class="reconnect-banner" onclick={() => (showReconnect = true)}>
				Nextcloud connection failed — <strong>Reconnect</strong>
			</button>
		{/if}
		{@render children()}
	{:else if gate === 'onboard'}
		<Onboarding {username} ondone={onboarded} />
	{:else}
		<div class="boot" aria-label="Loading">
			<span class="boot-spin"></span>
		</div>
	{/if}
</div>

{#if showReconnect}
	<div class="reconnect-overlay">
		<Onboarding {username} reconnect ondone={onboarded} oncancel={() => (showReconnect = false)} />
	</div>
{/if}

<style>
	.reconnect-banner {
		flex: none;
		margin: calc(env(safe-area-inset-top) + 8px) 16px 0;
		padding: 10px 14px;
		border-radius: 12px;
		background: color-mix(in srgb, var(--danger) 14%, var(--card));
		color: var(--danger);
		font-size: 14px;
		text-align: left;
	}

	/* When the banner is present the screen's own navbar top inset doubles up;
	   acceptable — the banner is a rare, transient state. */

	.boot {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.boot-spin {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		border: 3px solid var(--field);
		border-top-color: var(--muted);
		animation: boot-rotate 0.8s linear infinite;
	}

	@keyframes boot-rotate {
		to {
			transform: rotate(360deg);
		}
	}

	.reconnect-overlay {
		position: fixed;
		inset: 0;
		z-index: 70;
		background: var(--bg);
		display: flex;
		flex-direction: column;
	}
</style>
