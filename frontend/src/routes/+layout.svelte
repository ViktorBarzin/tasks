<script lang="ts">
	/**
	 * The app gate. Launch order: hydrate the Replica (instant render from
	 * IndexedDB — the app must work with the network cut), then decide
	 * onboarding vs app. A device that has onboarded before goes straight in
	 * on the cached flag; /api/me is only awaited on first run. A 401 from
	 * sync later flips needsReconnect → banner → re-onboarding overlay.
	 */
	import { onMount, type Snippet } from 'svelte';
	import { get } from 'svelte/store';
	import { pwaInfo } from 'virtual:pwa-info';

	import '../app.css';

	import { api } from '$lib/api';
	import Onboarding from '$lib/components/Onboarding.svelte';
	import * as db from '$lib/db';
	import { loadReplica, replica } from '$lib/replica';
	import { scheduleSwUpdates } from '$lib/pwa';
	import {
		deadOps,
		needsLogin,
		needsReconnect,
		startSync,
		syncNow,
		syncStuck
	} from '$lib/sync';

	let { children }: { children: Snippet } = $props();

	let gate = $state<'loading' | 'onboard' | 'app'>('loading');
	let username = $state('');
	let showReconnect = $state(false);
	/** Entering the app with an empty Replica (fresh onboard / new device):
	 * cover the shell until the initial full sync lands. */
	let firstSync = $state(false);

	const webManifestLink = pwaInfo ? pwaInfo.webManifest.linkTag : '';

	onMount(async () => {
		if ('serviceWorker' in navigator) {
			// vite-plugin-pwa autoUpdate: the generated SW swaps itself in when a
			// new deploy lands. Poll for new deploys hourly + on foreground so an
			// installed PWA doesn't pin a stale bundle (§K).
			const { registerSW } = await import('virtual:pwa-register');
			registerSW({
				immediate: true,
				onRegisteredSW(_swUrl, registration) {
					if (registration) scheduleSwUpdates(registration);
				}
			});
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
		const { lists, tasks } = get(replica);
		firstSync = lists.size === 0 && tasks.size === 0;
		startSync();
		if (firstSync) {
			// Progress for the initial full snapshot: syncNow coalesces into the
			// cycle startSync just kicked and resolves when it finishes — success
			// or not (offline resolves immediately; retries run in background).
			void syncNow().finally(() => (firstSync = false));
		}
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
		{#if $needsLogin}
			<button class="reconnect-banner" onclick={() => window.location.assign('/')}>
				Session expired — <strong>sign in</strong>
			</button>
		{:else if $needsReconnect && !showReconnect}
			<button class="reconnect-banner" onclick={() => (showReconnect = true)}>
				Nextcloud connection failed — <strong>Reconnect</strong>
			</button>
		{/if}
		{#if $deadOps > 0}
			<div class="dead-banner" role="status">
				{$deadOps} task{$deadOps === 1 ? '' : 's'} couldn’t sync and {$deadOps === 1
					? 'was'
					: 'were'} set aside.
			</div>
		{:else if $syncStuck}
			<div class="stuck-banner" role="status">Having trouble syncing — still retrying…</div>
		{/if}
		{@render children()}
		{#if firstSync}
			<div class="first-sync" role="status">
				<span class="boot-spin"></span>
				<p>Downloading your tasks from Nextcloud…</p>
			</div>
		{/if}
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

	.dead-banner,
	.stuck-banner {
		flex: none;
		margin: calc(env(safe-area-inset-top) + 8px) 16px 0;
		padding: 10px 14px;
		border-radius: 12px;
		font-size: 14px;
		text-align: left;
	}

	.dead-banner {
		background: color-mix(in srgb, var(--danger) 14%, var(--card));
		color: var(--danger);
	}

	.stuck-banner {
		background: color-mix(in srgb, var(--orange) 16%, var(--card));
		color: var(--orange);
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

	.first-sync {
		position: fixed;
		inset: 0;
		z-index: 40;
		background: var(--bg);
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 16px;
	}

	.first-sync p {
		margin: 0;
		color: var(--muted);
		font-size: 15px;
	}
</style>
