<script lang="ts">
	/** The completed-section toggle every task screen carries under its title:
	 * "N Completed · Show/Hide". Hidden entirely while there is nothing
	 * completed to reveal. */
	interface Props {
		count: number;
		shown: boolean;
		ontoggle: () => void;
	}
	let { count, shown, ontoggle }: Props = $props();
</script>

{#if count > 0 || shown}
	<div class="completed-bar">
		<span class="count">{count} Completed</span>
		<button class="toggle" onclick={ontoggle}>{shown ? 'Hide' : 'Show'}</button>
	</div>
{/if}

<style>
	.completed-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 2px 2px 10px;
		font-size: 15px;
	}

	.count {
		color: var(--muted);
	}

	.toggle {
		color: var(--accent);
		font-weight: 500;
		padding: 2px 4px;
	}
</style>
