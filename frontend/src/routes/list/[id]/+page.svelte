<script lang="ts">
	/**
	 * One List's screen: its Tasks off the Replica (open section sorted by the
	 * List's device-local sort mode, completed section toggleable, everything
	 * search-filterable), quick-add into this List, and the "…" menu with
	 * Sort By (Custom / Priority / Due Date — persisted per List in IndexedDB
	 * meta, contract delta v1.3 §3) plus the List lifecycle — rename, and
	 * delete behind a typed-confirm (Nextcloud's calendar trashbin is the
	 * recovery net, ADR/design §10).
	 *
	 * In Custom mode the open rows reorder by long-press-to-lift drag — the
	 * same dragReorder/holdGesture engine Home uses, wrapped rows instead of
	 * anchors (TaskRow renders buttons only, so iOS structurally cannot show a
	 * link preview). Pull-to-refresh needs no special-casing here (same as
	 * Home's long-press path): a hold is stationary by definition (>8px
	 * cancels it), so PTR never arms before a lift, and after the lift the
	 * action's touchmove blocker owns the stream. A drop emits MINIMAL
	 * task_update ops via planTaskReorder (contract delta v1.3 §4). In
	 * Priority/Due modes the action is disabled: a long-press shows nothing.
	 */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import { createTask, deleteList, recentlyCompleted, renameList, reorderTasks } from '$lib/actions';
	import ActionMenu from '$lib/components/ActionMenu.svelte';
	import CompletedBar from '$lib/components/CompletedBar.svelte';
	import Dialog from '$lib/components/Dialog.svelte';
	import QuickAdd from '$lib/components/QuickAdd.svelte';
	import Screen from '$lib/components/Screen.svelte';
	import TaskRow from '$lib/components/TaskRow.svelte';
	import TaskSheet from '$lib/components/TaskSheet.svelte';
	import { getMeta, setMeta } from '$lib/db';
	import { replica, replicaLoaded } from '$lib/replica';
	import { coerceSortMode, planTaskReorder, sortModeMetaKey, type SortMode } from '$lib/sort';
	import type { Priority, Task } from '$lib/types';
	import { now } from '$lib/ui/clock';
	import { applyReorder, dragReorder } from '$lib/ui/dragReorder';
	import { listColor } from '$lib/ui/listColors';
	import { buildListSections, buildListView, filterTasks } from '$lib/views';

	let listId = $derived(page.params.id ?? '');
	let list = $derived($replica.lists.get(listId));
	let tint = $derived(listColor(listId));

	let query = $state('');
	let showCompleted = $state(false);
	let sheetTask = $state<Task | null>(null);
	let menuOpen = $state(false);
	let sortMenuOpen = $state(false);
	let renameOpen = $state(false);
	let deleteOpen = $state(false);

	// Quick-add draft (bindable into QuickAdd); the expand chevron hands it to
	// the New-Task sheet, which clears it only when it actually creates.
	let draftTitle = $state('');
	let draftPriority = $state<Priority>(0);
	let createOpen = $state(false);

	function clearDraft(): void {
		draftTitle = '';
		draftPriority = 0;
	}

	// --- Sort mode: per-List, device-local (IndexedDB meta — never synced). ---
	const SORT_LABEL: Record<SortMode, string> = {
		custom: 'Custom',
		priority: 'Priority',
		due: 'Due Date'
	};
	let sortMode = $state<SortMode>('custom');
	$effect(() => {
		const id = listId;
		if (!id) return;
		void getMeta(sortModeMetaKey(id)).then((stored) => {
			if (listId === id) sortMode = coerceSortMode(stored);
		});
	});

	function setSortMode(mode: SortMode): void {
		sortMode = mode;
		void setMeta(sortModeMetaKey(listId), mode);
	}

	let sections = $derived(
		buildListSections(
			$replica,
			listId,
			{ showCompleted, now: $now, grace: $recentlyCompleted },
			sortMode
		)
	);
	let openRows = $derived(filterTasks(sections.open, query));
	let doneRows = $derived(filterTasks(sections.done, query));
	let completedCount = $derived(
		buildListView($replica, listId, { showCompleted: true, now: $now }).filter(
			(t) => t.completed
		).length
	);

	// --- Custom-mode reorder (long-press-to-lift, Home's engine). Search off:
	// a drop on a filtered subset would compute wrong neighbors. `pendingOrder`
	// bridges the ms between the drop's re-render (inside the action's
	// flushSync) and the optimistic ops re-sorting the store.
	let pendingOrder = $state<string[] | null>(null);
	let dragEnabled = $derived(sortMode === 'custom' && !query.trim());

	let displayOpen = $derived.by((): Task[] => {
		if (!pendingOrder) return openRows;
		const byId = new Map(openRows.map((t) => [t.uid, t]));
		return pendingOrder.map((id) => byId.get(id)).filter((t): t is Task => t !== undefined);
	});

	/** Drop from the dragReorder action — runs inside flushSync, so setting
	 * `pendingOrder` re-renders the rows before the action's transform reset. */
	function onreorder(from: number, to: number): void {
		const rows = displayOpen;
		pendingOrder = applyReorder(rows, from, to).map((t) => t.uid);
		void commitReorder(planTaskReorder(rows, from, to));
	}

	async function commitReorder(changes: ReturnType<typeof planTaskReorder>): Promise<void> {
		try {
			await reorderTasks(changes);
		} finally {
			pendingOrder = null;
		}
	}

	async function quickAdd(fields: { title: string; priority: Priority }): Promise<void> {
		await createTask(listId, fields);
	}

	async function rename(name: string): Promise<void> {
		renameOpen = false;
		if (list && name !== list.name) await renameList(listId, name);
	}

	/** Leave first, then record the Op — no "List not found" flash. */
	async function confirmDelete(): Promise<void> {
		deleteOpen = false;
		const id = listId;
		await goto('/');
		await deleteList(id);
	}
</script>

{#if list}
	<Screen title={list.name} {tint} back={{ href: '/', label: 'Lists' }}>
		{#snippet right()}
			<button class="menu-btn" aria-label="List options" onclick={() => (menuOpen = true)}>
				<svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
					<circle cx="12" cy="12" r="9.25" stroke="currentColor" stroke-width="1.5" />
					<circle cx="7.5" cy="12" r="1.3" fill="currentColor" />
					<circle cx="12" cy="12" r="1.3" fill="currentColor" />
					<circle cx="16.5" cy="12" r="1.3" fill="currentColor" />
				</svg>
			</button>
		{/snippet}

		{#snippet bottom()}
			<QuickAdd
				bind:text={draftTitle}
				bind:priority={draftPriority}
				onadd={quickAdd}
				onexpand={() => (createOpen = true)}
			/>
		{/snippet}

		<input
			class="search"
			type="search"
			placeholder="Search"
			bind:value={query}
			autocomplete="off"
			aria-label="Search in {list.name}"
		/>

		<CompletedBar
			count={completedCount}
			shown={showCompleted}
			ontoggle={() => (showCompleted = !showCompleted)}
		/>

		{#if displayOpen.length === 0 && doneRows.length === 0}
			<p class="empty">
				{query.trim() ? `No results for “${query.trim()}”` : 'No Tasks — add one below.'}
			</p>
		{:else}
			<div
				class="card hairline-rows"
				use:dragReorder={{ enabled: dragEnabled, liftOnHold: true, onreorder }}
			>
				{#each displayOpen as t (t.uid)}
					<!-- Long-press drag target (Custom mode). Static touch-action /
					     callout-off, exactly like Home's rows: iOS decides the gesture
					     before any JS runs, and the list still pan-y scrolls until a
					     lift actually happens. -->
					<div class="task-item" data-drag-item>
						<TaskRow task={t} now={$now} {tint} onopen={() => (sheetTask = t)} />
					</div>
				{/each}
				{#each doneRows as t (t.uid)}
					<!-- Completed section: never draggable, order untouched by the mode. -->
					<div class="task-item">
						<TaskRow task={t} now={$now} {tint} onopen={() => (sheetTask = t)} />
					</div>
				{/each}
			</div>
		{/if}
	</Screen>
{:else}
	<Screen title="List" back={{ href: '/', label: 'Lists' }}>
		<p class="empty">
			{#if $replicaLoaded}This List no longer exists.{:else}Loading…{/if}
		</p>
	</Screen>
{/if}

<TaskSheet open={sheetTask !== null} task={sheetTask} onclose={() => (sheetTask = null)} />

<!-- Expanded quick-add: create sheet prefilled with the draft (v0.2 feature 3). -->
<TaskSheet
	open={createOpen}
	defaultListId={listId}
	defaultTitle={draftTitle}
	defaultPriority={draftPriority}
	onsaved={clearDraft}
	onclose={() => (createOpen = false)}
/>

<ActionMenu
	open={menuOpen}
	title={list?.name ?? ''}
	actions={[
		{ label: `Sort By: ${SORT_LABEL[sortMode]}`, action: () => (sortMenuOpen = true) },
		{ label: 'Rename List', action: () => (renameOpen = true) },
		{ label: 'Delete List', danger: true, action: () => (deleteOpen = true) }
	]}
	onclose={() => (menuOpen = false)}
/>

<!-- iOS-Reminders-style Sort By picker: ✓ on the current mode, per-List. -->
<ActionMenu
	open={sortMenuOpen}
	title="Sort By"
	actions={[
		{ label: 'Custom', checked: sortMode === 'custom', action: () => setSortMode('custom') },
		{ label: 'Priority', checked: sortMode === 'priority', action: () => setSortMode('priority') },
		{ label: 'Due Date', checked: sortMode === 'due', action: () => setSortMode('due') }
	]}
	onclose={() => (sortMenuOpen = false)}
/>

<Dialog
	open={renameOpen}
	title="Rename List"
	withInput
	initial={list?.name ?? ''}
	placeholder="List name"
	confirmLabel="Rename"
	onconfirm={(v) => void rename(v)}
	oncancel={() => (renameOpen = false)}
/>

<Dialog
	open={deleteOpen}
	title="Delete List?"
	message={`This deletes “${list?.name ?? ''}” and every Task in it from Nextcloud (recoverable from its trash bin for a while). Type the list name to confirm.`}
	requireMatch={list?.name ?? ''}
	placeholder={list?.name ?? ''}
	confirmLabel="Delete"
	danger
	onconfirm={() => void confirmDelete()}
	oncancel={() => (deleteOpen = false)}
/>

<style>
	.menu-btn {
		display: flex;
		align-items: center;
		color: var(--accent);
		padding: 4px;
	}

	/* Rows are long-press drag targets in Custom mode: callout/select off
	   statically (iOS decides the gesture before JS runs) and `pan-y` so the
	   list still scrolls until a lift actually happens; after the lift the
	   dragReorder action's touchmove blocker owns the stream. `position` +
	   the zero box-shadow are the lift styling's static base (Home parity). */
	.task-item {
		position: relative;
		box-shadow: 0 0 0 rgba(0, 0, 0, 0);
		touch-action: pan-y;
		-webkit-touch-callout: none;
		-webkit-user-select: none;
		user-select: none;
	}

	/* The lift look — the action drives transforms/transitions inline;
	   this is only the static shadow/stacking. */
	.task-item:global(.drag-lifted) {
		z-index: 2;
		background: var(--card);
		border-radius: 10px;
		box-shadow: 0 3px 14px rgba(0, 0, 0, 0.22);
	}
</style>
