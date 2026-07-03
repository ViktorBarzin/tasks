<script lang="ts">
	/**
	 * The screen shell every page uses: fixed nav bar (back link, status
	 * pills, per-screen actions), an inner scroller with pull-to-refresh
	 * (the page itself never scrolls), and an optional bottom bar sitting
	 * above the home-indicator safe area.
	 */
	import type { Snippet } from 'svelte';

	import { syncNow } from '$lib/sync';
	import { pullToRefresh } from '$lib/ui/pullToRefresh';

	import StatusPills from './StatusPills.svelte';

	interface Props {
		title: string;
		tint?: string;
		back?: { href: string; label: string };
		/** Switch pull-to-refresh off while a mode owns the touch stream (Edit-mode drag). */
		refreshDisabled?: boolean;
		right?: Snippet;
		bottom?: Snippet;
		children: Snippet;
	}
	let { title, tint, back, refreshDisabled = false, right, bottom, children }: Props = $props();
</script>

<div class="screen">
	<header class="navbar">
		<div class="nav-side left">
			{#if back}
				<a class="back" href={back.href}>
					<svg width="13" height="20" viewBox="0 0 13 20" fill="none" aria-hidden="true"><path d="M11 2 3 10l8 8" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
					{back.label}
				</a>
			{/if}
		</div>
		<div class="nav-side right">
			<StatusPills />
			{#if right}{@render right()}{/if}
		</div>
	</header>

	<div class="scroller" use:pullToRefresh={{ onrefresh: () => syncNow(), enabled: !refreshDisabled }}>
		<div class="ptr" aria-hidden="true"><span class="ptr-spinner"></span></div>
		<h1 class="large-title" style:color={tint ?? 'inherit'}>{title}</h1>
		{@render children()}
		<div class="tail-space"></div>
	</div>

	{#if bottom}
		<div class="bottombar">{@render bottom()}</div>
	{/if}
</div>

<style>
	.screen {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.navbar {
		flex: none;
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 8px;
		padding: calc(env(safe-area-inset-top) + 6px) 12px 6px;
		min-height: calc(env(safe-area-inset-top) + 44px);
		background: var(--bg);
	}

	.nav-side {
		display: flex;
		align-items: center;
		gap: 10px;
		min-height: 32px;
	}

	.back {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: var(--accent);
		font-size: 17px;
		font-weight: 500;
		padding: 4px 6px 4px 0;
	}

	/* The inner scroller — the only thing that scrolls. */
	.scroller {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		overscroll-behavior-y: contain;
		padding: 0 16px;
	}

	/* Pull-to-refresh: the spacer grows with the pull; spinner fades in. */
	.ptr {
		height: var(--ptr-offset, 0px);
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
	}

	.scroller:not(.ptr-pulling) .ptr {
		transition: height 0.22s ease;
	}

	.ptr-spinner {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 2.5px solid var(--field);
		border-top-color: var(--muted);
		opacity: 0;
		transform: rotate(calc(var(--ptr-offset, 0px) * 3deg));
		transition: opacity 0.15s ease;
	}

	/* ptr-* classes are added at runtime by the pullToRefresh action, so they
	   must be :global for the scoped-CSS compiler to keep these rules. */
	.scroller:global(.ptr-armed) .ptr-spinner {
		opacity: 1;
	}

	.scroller:global(.ptr-refreshing) .ptr-spinner {
		opacity: 1;
		animation: ptr-rotate 0.8s linear infinite;
	}

	@keyframes ptr-rotate {
		to {
			transform: rotate(360deg);
		}
	}

	.large-title {
		font-size: 34px;
		font-weight: 700;
		letter-spacing: -0.02em;
		margin: 4px 0 12px;
	}

	.tail-space {
		height: 32px;
	}

	.bottombar {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 16px max(env(safe-area-inset-bottom), 12px);
		background: var(--bg);
		border-top: 0.5px solid var(--hairline);
	}
</style>
