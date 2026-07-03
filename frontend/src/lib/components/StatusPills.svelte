<script lang="ts">
	/** Offline indicator + pending-ops badge + sync spinner (every screen's
	 * nav bar). Pending count > 0 while offline is the "your edits are safe,
	 * queued" signal. */
	import { online, pendingOps, syncing } from '$lib/sync';
	import Icon from './Icon.svelte';

	const OFFLINE = 'M3 3l18 18M9 5a10 10 0 0 1 11 3M5 9a10 10 0 0 1 2-1.5M8.5 12.5A6 6 0 0 1 12 11m4.5 1.5a6 6 0 0 1 1 1M12 19h.01';
</script>

<span class="pills">
	{#if !$online}
		<span class="pill offline" title="Offline — changes are queued">
			<Icon path={OFFLINE} size={14} stroke={1.8} />
			Offline
		</span>
	{/if}
	{#if $pendingOps > 0}
		<span class="pill pending" title="{$pendingOps} unsynced change{$pendingOps === 1 ? '' : 's'}">
			{$pendingOps}
			<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
		</span>
	{:else if $syncing}
		<span class="spin" aria-label="Syncing"></span>
	{/if}
</span>

<style>
	.pills {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	.pill {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 12px;
		font-weight: 600;
		padding: 3px 8px;
		border-radius: 999px;
	}

	.offline {
		background: var(--field);
		color: var(--muted);
	}

	.pending {
		background: color-mix(in srgb, var(--orange) 18%, transparent);
		color: var(--orange);
	}

	.spin {
		width: 13px;
		height: 13px;
		border-radius: 50%;
		border: 2px solid var(--field);
		border-top-color: var(--muted);
		animation: rotate 0.8s linear infinite;
	}

	@keyframes rotate {
		to {
			transform: rotate(360deg);
		}
	}
</style>
