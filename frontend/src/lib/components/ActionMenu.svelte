<script lang="ts">
	/** iOS action sheet — used for the per-list "…" menu and its Sort By picker. */
	import { fade, fly } from 'svelte/transition';

	export interface MenuAction {
		label: string;
		danger?: boolean;
		/** Radio-style rows (Sort By): ✓ marks the current choice. */
		checked?: boolean;
		action: () => void;
	}

	interface Props {
		open: boolean;
		title?: string;
		actions: MenuAction[];
		onclose: () => void;
	}
	let { open, title = '', actions, onclose }: Props = $props();

	function run(a: MenuAction): void {
		onclose();
		a.action();
	}
</script>

{#if open}
	<div class="overlay" role="menu" tabindex="-1" onkeydown={(e) => e.key === 'Escape' && onclose()}>
		<button class="scrim" aria-label="Close menu" onclick={onclose} transition:fade={{ duration: 150 }}></button>
		<div class="sheet" transition:fly={{ y: 200, duration: 220 }}>
			<div class="group">
				{#if title}<div class="sheet-title">{title}</div>{/if}
				{#each actions as a (a.label)}
					<button
						class="item"
						class:danger={a.danger}
						role={a.checked !== undefined ? 'menuitemradio' : undefined}
						aria-checked={a.checked !== undefined ? a.checked : undefined}
						onclick={() => run(a)}
					>
						{#if a.checked !== undefined}
							<span class="tick" aria-hidden="true">{a.checked ? '✓' : ''}</span>
						{/if}
						{a.label}
					</button>
				{/each}
			</div>
			<div class="group">
				<button class="item cancel" onclick={onclose}>Cancel</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 55;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
	}

	.scrim {
		position: absolute;
		inset: 0;
		background: var(--sheet-scrim);
	}

	.sheet {
		position: relative;
		padding: 8px 10px max(env(safe-area-inset-bottom), 10px);
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.group {
		border-radius: 14px;
		background: var(--card);
		overflow: hidden;
	}

	.group > * + * {
		border-top: 0.5px solid var(--hairline);
	}

	.sheet-title {
		text-align: center;
		font-size: 13px;
		color: var(--muted);
		padding: 10px 16px;
	}

	.item {
		display: block;
		width: 100%;
		text-align: center;
		padding: 15px 16px;
		font-size: 19px;
		color: var(--accent);
	}

	.item:active {
		background: var(--card-pressed);
	}

	/* Fixed-width slot so radio-style labels stay centered as a column. */
	.tick {
		display: inline-block;
		width: 22px;
		margin-left: -22px;
		text-align: left;
		font-weight: 600;
	}

	.item.danger {
		color: var(--danger);
	}

	.item.cancel {
		font-weight: 600;
	}
</style>
