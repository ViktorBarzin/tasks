<script lang="ts">
	/** The quick-add row pinned at the bottom of task screens: type, hit
	 * return, task lands in the current context (list / due) instantly.
	 * A compact priority control (None/!/!!/!!! — TaskRow's marks) rides in
	 * the row, and the expand chevron hands the draft to the full New-Task
	 * sheet (title prefilled) for notes / due / list (v0.2 features 2+3).
	 * `text`/`priority` are bindable so the parent can keep the draft across
	 * the sheet round-trip and clear it once the sheet actually creates. */
	import type { Priority } from '$lib/types';

	interface Props {
		placeholder?: string;
		/** The draft title (bindable — survives an expand round-trip). */
		text?: string;
		/** The draft priority (bindable). */
		priority?: Priority;
		onadd: (fields: { title: string; priority: Priority }) => Promise<unknown> | void;
		/** Open the full New-Task sheet with the current draft. */
		onexpand?: () => void;
	}
	let {
		placeholder = 'New Task',
		text = $bindable(''),
		priority = $bindable(0),
		onadd,
		onexpand
	}: Props = $props();

	/** Tap-to-cycle escalation: None → ! (Low 9) → !! (Medium 5) → !!! (High 1). */
	const CYCLE: Record<Priority, Priority> = { 0: 9, 9: 5, 5: 1, 1: 0 };
	const MARK: Record<Priority, string> = { 0: '!', 9: '!', 5: '!!', 1: '!!!' };
	const NAME: Record<Priority, string> = { 0: 'None', 9: 'Low', 5: 'Medium', 1: 'High' };

	async function commit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		const title = text.trim();
		if (!title) return;
		const fields = { title, priority };
		text = '';
		priority = 0;
		await onadd(fields);
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
	<button
		type="button"
		class="prio"
		class:set={priority !== 0}
		aria-label={`Priority: ${NAME[priority]}`}
		title={`Priority: ${NAME[priority]}`}
		onclick={() => (priority = CYCLE[priority])}
	>
		{MARK[priority]}
	</button>
	{#if onexpand}
		<button type="button" class="expand" aria-label="More options" onclick={onexpand}>
			<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 15l7-7 7 7" /></svg>
		</button>
	{/if}
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

	/* The cycling priority mark — renders exactly like TaskRow's !/!!/!!!. */
	.prio {
		flex: none;
		min-width: 30px;
		padding: 3px 4px;
		font-weight: 700;
		letter-spacing: 0.5px;
		color: var(--muted);
		opacity: 0.4;
		text-align: center;
	}

	.prio.set {
		color: var(--accent);
		opacity: 1;
	}

	.expand {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		margin: -2px -4px -2px 0;
		border-radius: 50%;
		color: var(--accent);
	}
</style>
