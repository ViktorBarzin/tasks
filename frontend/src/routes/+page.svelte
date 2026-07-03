<script lang="ts">
	/** Home: search, Smart View tiles (Today / Scheduled / All with counts),
	 * My Lists with open counts (long-press a row to reorder; Edit → drag
	 * handles, both server-backed via list_reorder ops), New Task + Add List in
	 * the bottom bar.
	 *
	 * NOTHING on Home is an <a>: iOS owns long-press on links (Safari link
	 * preview / context menu), which both looks wrong in a standalone PWA and
	 * steals the long-press-to-reorder gesture. Tiles and rows are role="link"
	 * elements navigating via goto(), with touch-callout/user-select off
	 * statically — iOS decides the gesture BEFORE any JS runs. */
	import { goto } from '$app/navigation';

	import { createList, recentlyCompleted, reorderLists } from '$lib/actions';
	import Dialog from '$lib/components/Dialog.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Screen from '$lib/components/Screen.svelte';
	import TaskRow from '$lib/components/TaskRow.svelte';
	import TaskSheet from '$lib/components/TaskSheet.svelte';
	import { replica, replicaLoaded } from '$lib/replica';
	import type { Task, TaskList } from '$lib/types';
	import { now } from '$lib/ui/clock';
	import { applyReorder, dragReorder } from '$lib/ui/dragReorder';
	import { listColor } from '$lib/ui/listColors';
	import { planListReorder, searchTasks, sortedLists, viewCounts } from '$lib/views';

	let query = $state('');
	let addListOpen = $state(false);
	let newTaskOpen = $state(false);
	let sheetTask = $state<Task | null>(null);

	let lists = $derived(sortedLists($replica));
	let counts = $derived(viewCounts($replica, $now));
	let hits = $derived(searchTasks($replica, query));

	// --- Reordering (contract v1.2 §2), two entry points: long-press-to-lift on
	// any row (no Edit mode — native Reminders behavior, liftOnHold) and the
	// Edit-mode drag handles (immediate grab). The dragReorder action owns the
	// gesture (transforms only, rAF-driven) and reports the drop as (from, to);
	// the commit emits one list_reorder op per changed List and `pendingOrder`
	// bridges the ms until the optimistic fold re-sorts the store.
	// Pull-to-refresh is off for the whole Edit mode so an at-the-top downward
	// drag can never be hijacked as a refresh pull; outside Edit mode a
	// long-press hold is stationary by definition (>8px cancels it), so PTR
	// never arms before a lift, and after the lift the action's touchmove
	// blocker owns the stream.
	let editMode = $state(false);
	let pendingOrder = $state<string[] | null>(null);

	let displayLists = $derived.by((): TaskList[] => {
		if (!pendingOrder) return lists;
		const byId = new Map(lists.map((l) => [l.id, l]));
		return pendingOrder.map((id) => byId.get(id)).filter((l): l is TaskList => l !== undefined);
	});

	function toggleEdit(): void {
		editMode = !editMode;
	}

	/** Drop from the dragReorder action — runs inside flushSync, so setting
	 * `pendingOrder` re-renders the rows before the action's transform reset. */
	function onreorder(from: number, to: number): void {
		const ids = applyReorder(
			displayLists.map((l) => l.id),
			from,
			to
		);
		pendingOrder = ids;
		void commitReorder(ids);
	}

	async function commitReorder(ids: string[]): Promise<void> {
		try {
			await reorderLists(planListReorder(lists, ids));
		} finally {
			pendingOrder = null;
		}
	}

	const ICON_TODAY = 'M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.5 1.5M16.9 16.9l1.5 1.5M18.4 5.6l-1.5 1.5M7.1 16.9l-1.5 1.5M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z';
	const ICON_SCHEDULED = 'M8 3v4M16 3v4M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z';
	const ICON_ALL = 'M4 6h16M4 12h16M4 18h10';
	const ICON_LIST = 'M8 7h9M8 12h9M8 17h9M4.5 7h.01M4.5 12h.01M4.5 17h.01';

	let tiles = $derived([
		{ href: '/view/today', label: 'Today', color: '#007aff', icon: ICON_TODAY, count: counts.today },
		{ href: '/view/scheduled', label: 'Scheduled', color: '#ff3b30', icon: ICON_SCHEDULED, count: counts.scheduled },
		{ href: '/view/all', label: 'All', color: '#8e8e93', icon: ICON_ALL, count: counts.all }
	]);

	async function addList(name: string): Promise<void> {
		addListOpen = false;
		const id = await createList(name);
		await goto(`/list/${id}`);
	}

	/** Keyboard activation for the role="link" tiles/rows (Enter, like an <a>). */
	function linkKeydown(e: KeyboardEvent, href: string): void {
		if (e.key !== 'Enter') return;
		e.preventDefault();
		void goto(href);
	}
</script>

<Screen title="Tasks" refreshDisabled={editMode}>
	{#snippet right()}
		{#if lists.length > 1 && !query.trim()}
			<button class="edit-btn" class:strong={editMode} onclick={toggleEdit}>
				{editMode ? 'Done' : 'Edit'}
			</button>
		{/if}
	{/snippet}

	{#snippet bottom()}
		<button class="new-task" onclick={() => (newTaskOpen = true)} disabled={lists.length === 0}>
			<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="currentColor" stroke="none" /><path d="M12 8.5v7M8.5 12h7" stroke="var(--bg)" /></svg>
			New Task
		</button>
		<button class="add-list" onclick={() => (addListOpen = true)}>Add List</button>
	{/snippet}

	<input
		class="search"
		type="search"
		placeholder="Search"
		bind:value={query}
		autocomplete="off"
		aria-label="Search tasks"
	/>

	{#if query.trim()}
		<div class="card hairline-rows results">
			{#each hits as hit (hit.task.uid)}
				<TaskRow
					task={hit.task}
					now={$now}
					tint={listColor(hit.task.list_id)}
					caption={hit.listName}
					onopen={() => (sheetTask = hit.task)}
				/>
			{:else}
				<p class="empty">No results for “{query.trim()}”</p>
			{/each}
		</div>
	{:else}
		<div class="tiles">
			{#each tiles as tile (tile.href)}
				<div
					class="tile card"
					role="link"
					tabindex="0"
					onclick={() => void goto(tile.href)}
					onkeydown={(e) => linkKeydown(e, tile.href)}
				>
					<span class="tile-top">
						<span class="tile-icon" style:background={tile.color}>
							<Icon path={tile.icon} size={16} stroke={2.2} />
						</span>
						<span class="tile-count">{tile.count}</span>
					</span>
					<span class="tile-label">{tile.label}</span>
				</div>
			{/each}
		</div>

		<h2 class="eyebrow section-heading">My Lists</h2>
		<div class="card hairline-rows" use:dragReorder={{ enabled: true, liftOnHold: true, onreorder }}>
			{#each displayLists as l (l.id)}
				{#if editMode}
					<div class="list-row" data-drag-item>
						<span class="list-dot" style:background={listColor(l.id)}>
							<Icon path={ICON_LIST} size={15} stroke={2} />
						</span>
						<span class="list-name">{l.name}</span>
						<button
							type="button"
							class="drag-handle"
							data-drag-handle
							aria-label={`Reorder ${l.name}`}
						>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 8h16M4 16h16" /></svg>
						</button>
					</div>
				{:else}
					<div
						class="list-row nav"
						data-drag-item
						role="link"
						tabindex="0"
						onclick={() => void goto(`/list/${l.id}`)}
						onkeydown={(e) => linkKeydown(e, `/list/${l.id}`)}
					>
						<span class="list-dot" style:background={listColor(l.id)}>
							<Icon path={ICON_LIST} size={15} stroke={2} />
						</span>
						<span class="list-name">{l.name}</span>
						<span class="list-count">{counts.byList.get(l.id) ?? 0}</span>
						<svg class="chevron" width="8" height="14" viewBox="0 0 8 14" fill="none" aria-hidden="true"><path d="m1.5 1.5 5 5.5-5 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
					</div>
				{/if}
			{:else}
				<p class="empty">
					{#if $replicaLoaded}No Lists yet — add one below.{:else}Loading…{/if}
				</p>
			{/each}
		</div>
	{/if}
</Screen>

<TaskSheet open={newTaskOpen} defaultListId={lists[0]?.id ?? ''} onclose={() => (newTaskOpen = false)} />
<TaskSheet open={sheetTask !== null} task={sheetTask} onclose={() => (sheetTask = null)} />
<Dialog
	open={addListOpen}
	title="New List"
	withInput
	placeholder="List name"
	confirmLabel="Create"
	onconfirm={(v) => void addList(v)}
	oncancel={() => (addListOpen = false)}
/>

<!-- recentlyCompleted keeps rows visible in Smart Views; referenced here so the
     store stays warm while the home screen is up (search results included). -->
<span hidden>{$recentlyCompleted.size}</span>

<style>
	.tiles {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	/* Tiles are role="link" divs, NOT anchors — see the header comment. The
	   static callout/select-off is what keeps iOS from claiming a long-press. */
	.tile {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 12px;
		color: inherit;
		cursor: pointer;
		-webkit-touch-callout: none;
		-webkit-user-select: none;
		user-select: none;
	}

	.tile:active {
		background: var(--card-pressed);
	}

	.tile-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.tile-icon {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		color: #fff;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.tile-count {
		font-size: 24px;
		font-weight: 700;
	}

	.tile-label {
		font-size: 15px;
		font-weight: 600;
		color: var(--muted);
	}

	.section-heading {
		margin: 22px 2px 8px;
	}

	/* Rows are long-press drag targets in EVERY mode: callout/select off
	   statically (iOS decides the gesture before JS runs) and `pan-y` so the
	   list still scrolls until a lift actually happens; after the lift the
	   dragReorder action's touchmove blocker owns the stream. `position` +
	   the zero box-shadow are the lift styling's static base. */
	.list-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 11px 14px;
		color: inherit;
		position: relative;
		box-shadow: 0 0 0 rgba(0, 0, 0, 0);
		touch-action: pan-y;
		-webkit-touch-callout: none;
		-webkit-user-select: none;
		user-select: none;
	}

	/* Nav rows only — grabbing a handle in Edit mode must not flash the row. */
	.list-row.nav {
		cursor: pointer;
	}

	.list-row.nav:active {
		background: var(--card-pressed);
	}

	.list-dot {
		flex: none;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		color: #fff;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.list-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.list-count {
		color: var(--muted);
		font-size: 17px;
	}

	.chevron {
		color: var(--hairline);
		flex: none;
	}

	.edit-btn {
		color: var(--accent);
		font-size: 17px;
		padding: 4px 2px;
	}

	.edit-btn.strong {
		font-weight: 600;
	}

	/* The lift look (any mode — long-press or Edit handle): the dragReorder
	   action drives transforms/transitions inline (rAF-throttled, content-space
	   math); this is only the static shadow/stacking. `.drag-lifted` is added
	   at runtime by the action. */
	.list-row:global(.drag-lifted) {
		z-index: 2;
		background: var(--card);
		border-radius: 10px;
		box-shadow: 0 3px 14px rgba(0, 0, 0, 0.22);
	}

	.drag-handle {
		flex: none;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 44px; /* iOS minimum hit target */
		height: 44px;
		margin: -7px -10px -7px 0;
		color: var(--muted);
		/* The drag owns the gesture from the very first touch — no native pan,
		   nothing for pull-to-refresh. Must be CSS: an inline write from
		   pointerdown is too late for the touch that just started. */
		touch-action: none;
		-webkit-touch-callout: none;
		cursor: grab;
	}

	.list-row:global(.drag-lifted) .drag-handle {
		cursor: grabbing;
	}

	.results {
		margin-top: 2px;
	}

	.new-task {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		color: var(--accent);
		font-size: 17px;
		font-weight: 600;
	}

	.new-task:disabled {
		opacity: 0.4;
	}

	.add-list {
		color: var(--accent);
		font-size: 17px;
	}
</style>
