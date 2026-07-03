<script lang="ts">
	/**
	 * One Task row, Reminders-close: round checkbox (tap to complete, with a
	 * strike animation and a grace period before the row leaves open views),
	 * !/!!/!!! priority marks, notes preview, due chip (red when overdue),
	 * repeat glyph for Recurring Tasks, swipe-right-to-complete.
	 */
	import { completeTask, uncompleteTask } from '$lib/actions';
	import { formatDueChip, isOverdue } from '$lib/dates';
	import type { Task } from '$lib/types';
	import { swipeComplete } from '$lib/ui/swipe';

	interface Props {
		task: Task;
		now: Date;
		tint?: string;
		/** Extra context line (list name in Smart Views / search). */
		caption?: string;
		onopen: () => void;
	}
	let { task, now, tint = 'var(--accent)', caption, onopen }: Props = $props();

	let overdue = $derived(isOverdue(task, now));

	function toggle(): void {
		if (task.completed) void uncompleteTask(task.uid);
		else void completeTask(task.uid);
	}

	const PRIO_MARK: Record<number, string> = { 1: '!!!', 5: '!!', 9: '!' };
</script>

<div class="row-wrap">
	<div class="swipe-under" aria-hidden="true">
		<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5 10 18 19.5 7" /></svg>
	</div>
	<div
		class="row"
		class:completed={task.completed}
		use:swipeComplete={{ oncommit: () => !task.completed && void completeTask(task.uid), enabled: !task.completed }}
	>
		<button
			class="check"
			class:on={task.completed}
			style:--tint={tint}
			onclick={toggle}
			aria-label={task.completed ? 'Mark incomplete' : 'Mark complete'}
		>
			<span class="dot"></span>
		</button>
		<button class="body" onclick={onopen}>
			<span class="title-line">
				{#if task.priority !== 0}
					<span class="prio" style:color={tint}>{PRIO_MARK[task.priority]}</span>
				{/if}
				<span class="title">{task.title}</span>
			</span>
			{#if task.notes}
				<span class="notes">{task.notes.split('\n')[0]}</span>
			{/if}
			{#if task.due || task.recurring || caption}
				<span class="meta">
					{#if task.due}
						<span class="due" class:overdue>{formatDueChip(task, now)}</span>
					{/if}
					{#if task.recurring}
						<svg class="repeat" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-label="Repeats"><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></svg>
					{/if}
					{#if caption}
						<span class="caption">{caption}</span>
					{/if}
				</span>
			{/if}
		</button>
	</div>
</div>

<style>
	.row-wrap {
		position: relative;
		background: #34c759;
	}

	.swipe-under {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		padding-left: 18px;
	}

	.row {
		position: relative;
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 11px 12px;
		background: var(--card);
		touch-action: pan-y;
	}

	.check {
		flex: none;
		width: 24px;
		height: 24px;
		margin-top: 1px;
		border-radius: 50%;
		border: 1.5px solid var(--muted);
		display: flex;
		align-items: center;
		justify-content: center;
		transition: border-color 0.2s ease;
	}

	/* Generous tap target without growing the visual circle. */
	.check::after {
		content: '';
		position: absolute;
		width: 44px;
		height: 44px;
		left: 0;
		top: 0;
	}

	.check .dot {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--tint);
		transform: scale(0);
		transition: transform 0.18s ease-out;
	}

	.check.on {
		border-color: var(--tint);
	}

	.check.on .dot {
		transform: scale(1);
	}

	.body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		text-align: left;
		padding: 0;
	}

	.title-line {
		display: flex;
		gap: 5px;
		align-items: baseline;
		min-width: 0;
	}

	.prio {
		font-weight: 700;
		flex: none;
		letter-spacing: 0.5px;
	}

	.title {
		position: relative;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		transition: color 0.25s ease;
	}

	/* The strike: a line that sweeps across on completion. */
	.title::after {
		content: '';
		position: absolute;
		left: 0;
		top: 55%;
		height: 1.5px;
		width: 0;
		background: var(--muted);
		transition: width 0.25s ease;
	}

	.completed .title {
		color: var(--muted);
	}

	.completed .title::after {
		width: 100%;
	}

	.completed .prio {
		color: var(--muted) !important;
	}

	.notes {
		font-size: 14px;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 14px;
		color: var(--muted);
	}

	.due.overdue {
		color: var(--danger);
	}

	.repeat {
		flex: none;
	}

	.caption::before {
		content: '·';
		margin-right: 6px;
	}

	:global(.row.swipe-armed) .check {
		border-color: #34c759;
	}
</style>
