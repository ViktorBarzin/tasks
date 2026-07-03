<script lang="ts">
	/** The quick-add row pinned at the bottom of task screens: type, hit
	 * return, task lands in the current context (list / due) instantly. */
	interface Props {
		placeholder?: string;
		onadd: (title: string) => Promise<unknown> | void;
	}
	let { placeholder = 'New Task', onadd }: Props = $props();

	let text = $state('');

	async function commit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const title = text.trim();
		if (!title) return;
		text = '';
		await onadd(title);
	}
</script>

<form class="quick-add" onsubmit={commit}>
	<span class="plus" aria-hidden="true">
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
	</span>
	<input
		bind:value={text}
		{placeholder}
		type="text"
		enterkeyhint="done"
		autocomplete="off"
		autocapitalize="sentences"
		aria-label="New task title"
	/>
</form>

<style>
	.quick-add {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 8px;
		background: var(--field);
		border-radius: 12px;
		padding: 8px 12px;
	}

	.plus {
		color: var(--accent);
		display: flex;
	}

	input {
		flex: 1;
		background: none;
		border: none;
		outline: none;
		min-width: 0;
	}
</style>
