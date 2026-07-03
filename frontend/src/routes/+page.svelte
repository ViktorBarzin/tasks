<script lang="ts">
	/** Home: search, Smart View tiles (Today / Scheduled / All with counts),
	 * My Lists with open counts, New Task + Add List in the bottom bar. */
	import { goto } from '$app/navigation';

	import { createList, recentlyCompleted } from '$lib/actions';
	import Dialog from '$lib/components/Dialog.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Screen from '$lib/components/Screen.svelte';
	import TaskRow from '$lib/components/TaskRow.svelte';
	import TaskSheet from '$lib/components/TaskSheet.svelte';
	import { replica, replicaLoaded } from '$lib/replica';
	import type { Task } from '$lib/types';
	import { now } from '$lib/ui/clock';
	import { listColor } from '$lib/ui/listColors';
	import { searchTasks, sortedLists, viewCounts } from '$lib/views';

	let query = $state('');
	let addListOpen = $state(false);
	let newTaskOpen = $state(false);
	let sheetTask = $state<Task | null>(null);

	let lists = $derived(sortedLists($replica));
	let counts = $derived(viewCounts($replica, $now));
	let hits = $derived(searchTasks($replica, query));

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
</script>

<Screen title="Tasks">
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
				<a class="tile card" href={tile.href}>
					<span class="tile-top">
						<span class="tile-icon" style:background={tile.color}>
							<Icon path={tile.icon} size={16} stroke={2.2} />
						</span>
						<span class="tile-count">{tile.count}</span>
					</span>
					<span class="tile-label">{tile.label}</span>
				</a>
			{/each}
		</div>

		<h2 class="eyebrow section-heading">My Lists</h2>
		<div class="card hairline-rows">
			{#each lists as l (l.id)}
				<a class="list-row" href={`/list/${l.id}`}>
					<span class="list-dot" style:background={listColor(l.id)}>
						<Icon path={ICON_LIST} size={15} stroke={2} />
					</span>
					<span class="list-name">{l.name}</span>
					<span class="list-count">{counts.byList.get(l.id) ?? 0}</span>
					<svg class="chevron" width="8" height="14" viewBox="0 0 8 14" fill="none" aria-hidden="true"><path d="m1.5 1.5 5 5.5-5 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
				</a>
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

	.tile {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 12px;
		color: inherit;
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

	.list-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 11px 14px;
		color: inherit;
	}

	.list-row:active {
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
