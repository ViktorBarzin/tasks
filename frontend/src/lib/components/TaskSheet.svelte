<script lang="ts">
	/**
	 * The task detail sheet (edit) / New Task sheet (create): title, notes,
	 * due date + optional time, priority segmented control, List picker,
	 * read-only repeat badge, delete. Saving diffs against the original and
	 * emits the minimal Ops (task_update / task_move / task_create).
	 */
	import { untrack } from 'svelte';
	import { fade, fly } from 'svelte/transition';

	import { createTask, deleteTask, moveTask, updateTask } from '$lib/actions';
	import { dueToInputs, inputsToDue, todayKey } from '$lib/dates';
	import { replica } from '$lib/replica';
	import type { Priority, Task, TaskFields } from '$lib/types';
	import { sortedLists } from '$lib/views';

	import Dialog from './Dialog.svelte';

	interface Props {
		open: boolean;
		/** Edit mode when set; create mode otherwise. */
		task?: Task | null;
		defaultListId?: string;
		defaultDue?: string | null;
		onclose: () => void;
	}
	let { open, task = null, defaultListId = '', defaultDue = null, onclose }: Props = $props();

	const PRIORITIES: { value: Priority; label: string }[] = [
		{ value: 0, label: 'None' },
		{ value: 9, label: 'Low' },
		{ value: 5, label: 'Medium' },
		{ value: 1, label: 'High' }
	];

	let lists = $derived(sortedLists($replica));

	let title = $state('');
	let notes = $state('');
	let date = $state('');
	let time = $state('');
	let priority = $state<Priority>(0);
	let listId = $state('');
	let confirmDelete = $state(false);

	let wasOpen = false;
	$effect(() => {
		const isOpen = open;
		untrack(() => {
			if (isOpen && !wasOpen) init();
			wasOpen = isOpen;
		});
	});

	function init(): void {
		confirmDelete = false;
		if (task) {
			title = task.title;
			notes = task.notes;
			({ date, time } = dueToInputs(task));
			priority = task.priority;
			listId = task.list_id;
		} else {
			title = '';
			notes = '';
			date = defaultDue ? defaultDue.slice(0, 10) : '';
			time = '';
			priority = 0;
			listId = defaultListId || lists[0]?.id || '';
		}
	}

	let canSave = $derived(title.trim().length > 0 && listId !== '');

	async function save(): Promise<void> {
		if (!canSave) return;
		const { due, due_has_time } = inputsToDue(date, time);
		if (task) {
			const patch: Partial<TaskFields> = {};
			const t = title.trim();
			if (t !== task.title) patch.title = t;
			if (notes !== task.notes) patch.notes = notes;
			if (due !== task.due || due_has_time !== task.due_has_time) {
				patch.due = due;
				patch.due_has_time = due_has_time;
			}
			if (priority !== task.priority) patch.priority = priority;
			if (Object.keys(patch).length) await updateTask(task.uid, patch);
			if (listId && listId !== task.list_id) await moveTask(task.uid, listId, task.list_id);
		} else {
			await createTask(listId, { title: title.trim(), notes, due, due_has_time, priority });
		}
		onclose();
	}

	async function removeTask(): Promise<void> {
		if (!task) return;
		confirmDelete = false;
		await deleteTask(task.uid);
		onclose();
	}

	function setRelativeDate(offsetDays: number): void {
		const d = new Date();
		d.setDate(d.getDate() + offsetDays);
		date = todayKey(d);
	}

	function clearDue(): void {
		date = '';
		time = '';
	}
</script>

{#if open}
	<div class="overlay" role="dialog" aria-modal="true" aria-label={task ? 'Task details' : 'New task'} tabindex="-1" onkeydown={(e) => e.key === 'Escape' && onclose()}>
		<button class="scrim" aria-label="Close" onclick={onclose} transition:fade={{ duration: 150 }}></button>
		<div class="sheet" transition:fly={{ y: 500, duration: 260 }}>
			<div class="grabber" aria-hidden="true"></div>
			<header>
				<button class="hdr-btn" onclick={onclose}>Cancel</button>
				<h2>{task ? 'Details' : 'New Task'}</h2>
				<button class="hdr-btn strong" disabled={!canSave} onclick={save}>{task ? 'Done' : 'Add'}</button>
			</header>

			<div class="sheet-scroll">
				<div class="group">
					<input
						class="row-input title-input"
						bind:value={title}
						placeholder="Title"
						type="text"
						autocapitalize="sentences"
						enterkeyhint="done"
					/>
					<textarea
						class="row-input notes-input"
						bind:value={notes}
						placeholder="Notes"
						rows="3"
					></textarea>
				</div>

				<div class="group">
					<div class="form-row">
						<span class="row-label">Date</span>
						<input class="picker" type="date" bind:value={date} />
					</div>
					<div class="form-row" class:disabled={!date}>
						<span class="row-label">Time</span>
						<input class="picker" type="time" bind:value={time} disabled={!date} />
					</div>
					<div class="chip-row">
						<button class="chip" onclick={() => setRelativeDate(0)}>Today</button>
						<button class="chip" onclick={() => setRelativeDate(1)}>Tomorrow</button>
						{#if date}<button class="chip clear" onclick={clearDue}>No Date</button>{/if}
					</div>
				</div>

				<div class="group">
					<div class="form-row">
						<span class="row-label">Priority</span>
					</div>
					<div class="segments" role="radiogroup" aria-label="Priority">
						{#each PRIORITIES as p (p.value)}
							<button
								class="segment"
								class:selected={priority === p.value}
								role="radio"
								aria-checked={priority === p.value}
								onclick={() => (priority = p.value)}>{p.label}</button
							>
						{/each}
					</div>
				</div>

				<div class="group">
					<div class="form-row">
						<span class="row-label">List</span>
						<select class="picker" bind:value={listId}>
							{#each lists as l (l.id)}
								<option value={l.id}>{l.name}</option>
							{/each}
						</select>
					</div>
					{#if task?.recurring}
						<div class="form-row repeat-row">
							<span class="row-label">
								<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></svg>
								Repeats
							</span>
							<span class="repeat-note">Completing schedules the next occurrence · edit the rule in Nextcloud</span>
						</div>
					{/if}
				</div>

				{#if task}
					<div class="group">
						<button class="delete-btn" onclick={() => (confirmDelete = true)}>Delete Task</button>
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<Dialog
	open={confirmDelete}
	title="Delete Task?"
	message={`“${task?.title ?? ''}” will be deleted from Nextcloud too.`}
	confirmLabel="Delete"
	danger
	onconfirm={() => void removeTask()}
	oncancel={() => (confirmDelete = false)}
/>

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 50;
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
		background: var(--bg);
		border-radius: 14px 14px 0 0;
		box-shadow: var(--shadow-sheet);
		max-height: calc(100dvh - max(env(safe-area-inset-top), 24px) - 16px);
		display: flex;
		flex-direction: column;
	}

	.grabber {
		width: 38px;
		height: 5px;
		border-radius: 3px;
		background: var(--hairline);
		margin: 6px auto 0;
		flex: none;
	}

	header {
		flex: none;
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		padding: 8px 16px;
	}

	h2 {
		font-size: 17px;
		font-weight: 600;
		margin: 0;
		text-align: center;
	}

	.hdr-btn {
		color: var(--accent);
		font-size: 17px;
		justify-self: start;
		padding: 4px 0;
	}

	.hdr-btn.strong {
		font-weight: 600;
		justify-self: end;
	}

	.hdr-btn:disabled {
		opacity: 0.35;
	}

	.sheet-scroll {
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		overscroll-behavior-y: contain;
		padding: 4px 16px max(env(safe-area-inset-bottom), 16px);
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.group {
		background: var(--card);
		border-radius: 12px;
		overflow: hidden;
	}

	.group > * + * {
		border-top: 0.5px solid var(--hairline);
	}

	.row-input {
		display: block;
		width: 100%;
		background: none;
		border: none;
		outline: none;
		padding: 12px 14px;
	}

	.title-input {
		font-weight: 500;
	}

	.notes-input {
		resize: none;
		min-height: 72px;
		font-size: 15px;
	}

	.form-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 14px;
		min-height: 44px;
	}

	.form-row.disabled {
		opacity: 0.45;
	}

	.row-label {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 16px;
	}

	.picker {
		background: var(--field);
		border: none;
		border-radius: 8px;
		padding: 6px 10px;
		outline: none;
		max-width: 60%;
		font-size: 15px;
	}

	.chip-row {
		display: flex;
		gap: 8px;
		padding: 10px 14px 12px;
	}

	.chip {
		font-size: 14px;
		font-weight: 500;
		color: var(--accent);
		background: var(--field);
		border-radius: 999px;
		padding: 5px 12px;
	}

	.chip.clear {
		color: var(--danger);
	}

	.segments {
		display: flex;
		gap: 4px;
		padding: 4px;
		margin: 8px 14px 12px;
		background: var(--field);
		border-radius: 10px;
	}

	.segment {
		flex: 1;
		padding: 6px 4px;
		font-size: 14px;
		font-weight: 500;
		border-radius: 8px;
		color: var(--fg-2);
	}

	.segment.selected {
		background: var(--card);
		color: var(--fg);
		font-weight: 600;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
	}

	.repeat-row {
		color: var(--muted);
	}

	.repeat-note {
		font-size: 12px;
		color: var(--muted);
		text-align: right;
		max-width: 65%;
	}

	.delete-btn {
		display: block;
		width: 100%;
		padding: 13px 16px;
		text-align: center;
		color: var(--danger);
		font-size: 17px;
	}

	.delete-btn:active {
		background: var(--card-pressed);
	}
</style>
