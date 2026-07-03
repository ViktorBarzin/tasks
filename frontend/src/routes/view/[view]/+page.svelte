<script lang="ts">
	/**
	 * The three Smart Views (CONTEXT.md): Today (due or overdue, flat),
	 * Scheduled (has a Due, grouped by day), All (open Tasks grouped by List).
	 * Pure derivations over the Replica; quick-add lands in the first List
	 * with a due of today where that keeps the new Task visible in the view.
	 */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import { createTask, recentlyCompleted } from '$lib/actions';
	import CompletedBar from '$lib/components/CompletedBar.svelte';
	import QuickAdd from '$lib/components/QuickAdd.svelte';
	import Screen from '$lib/components/Screen.svelte';
	import TaskRow from '$lib/components/TaskRow.svelte';
	import TaskSheet from '$lib/components/TaskSheet.svelte';
	import { todayKey } from '$lib/dates';
	import { replica } from '$lib/replica';
	import type { Task } from '$lib/types';
	import { now } from '$lib/ui/clock';
	import { listColor } from '$lib/ui/listColors';
	import {
		buildAllView,
		buildScheduledView,
		buildTodayView,
		filterGroups,
		filterTasks,
		sortedLists,
		type TaskGroup,
		type ViewOptions
	} from '$lib/views';

	type ViewName = 'today' | 'scheduled' | 'all';
	const VIEWS: Record<ViewName, { title: string; color: string; empty: string }> = {
		today: { title: 'Today', color: '#007aff', empty: 'Nothing due today.' },
		scheduled: { title: 'Scheduled', color: '#ff3b30', empty: 'Nothing scheduled.' },
		all: { title: 'All', color: '#8e8e93', empty: 'No open Tasks.' }
	};

	let view = $derived(page.params.view as ViewName);
	let cfg = $derived(VIEWS[view]);
	$effect(() => {
		if (!cfg) void goto('/', { replaceState: true });
	});

	let query = $state('');
	let showCompleted = $state(false);
	let sheetTask = $state<Task | null>(null);

	let lists = $derived(sortedLists($replica));
	let opts = $derived<ViewOptions>({
		showCompleted,
		now: $now,
		grace: $recentlyCompleted
	});

	/** Today renders flat; Scheduled/All render grouped. */
	let rows = $derived<Task[]>(
		view === 'today' ? filterTasks(buildTodayView($replica, opts), query) : []
	);
	let groups = $derived<TaskGroup[]>(
		view === 'scheduled'
			? filterGroups(buildScheduledView($replica, opts), query)
			: view === 'all'
				? filterGroups(buildAllView($replica, opts), query)
				: []
	);
	let isEmpty = $derived(view === 'today' ? rows.length === 0 : groups.length === 0);

	let completedCount = $derived.by(() => {
		if (!cfg) return 0;
		const withDone: ViewOptions = { showCompleted: true, now: $now };
		const tasks =
			view === 'today'
				? buildTodayView($replica, withDone)
				: view === 'scheduled'
					? buildScheduledView($replica, withDone).flatMap((g) => g.tasks)
					: buildAllView($replica, withDone).flatMap((g) => g.tasks);
		return tasks.filter((t) => t.completed).length;
	});

	function listName(t: Task): string {
		return $replica.lists.get(t.list_id)?.name ?? '';
	}

	/** Quick-add: first List; Today/Scheduled default the Due to today so the
	 * new Task stays visible in the view it was typed into. */
	async function quickAdd(title: string): Promise<void> {
		const listId = lists[0]?.id;
		if (!listId) return;
		await createTask(listId, view === 'all' ? { title } : { title, due: todayKey() });
	}
</script>

{#if cfg}
	<Screen title={cfg.title} tint={cfg.color} back={{ href: '/', label: 'Lists' }}>
		{#snippet bottom()}
			{#if lists.length > 0}
				<QuickAdd onadd={quickAdd} />
			{/if}
		{/snippet}

		<input
			class="search"
			type="search"
			placeholder="Search"
			bind:value={query}
			autocomplete="off"
			aria-label="Search in {cfg.title}"
		/>

		<CompletedBar
			count={completedCount}
			shown={showCompleted}
			ontoggle={() => (showCompleted = !showCompleted)}
		/>

		{#if isEmpty}
			<p class="empty">
				{query.trim() ? `No results for “${query.trim()}”` : cfg.empty}
			</p>
		{:else if view === 'today'}
			<div class="card hairline-rows">
				{#each rows as t (t.uid)}
					<TaskRow
						task={t}
						now={$now}
						tint={listColor(t.list_id)}
						caption={listName(t)}
						onopen={() => (sheetTask = t)}
					/>
				{/each}
			</div>
		{:else}
			{#each groups as g (g.key)}
				<h2 class="eyebrow group-heading" class:overdue={view === 'scheduled' && g.key < todayKey($now)}>
					{g.heading}
				</h2>
				<div class="card hairline-rows">
					{#each g.tasks as t (t.uid)}
						<TaskRow
							task={t}
							now={$now}
							tint={listColor(t.list_id)}
							caption={view === 'scheduled' ? listName(t) : undefined}
							onopen={() => (sheetTask = t)}
						/>
					{/each}
				</div>
			{/each}
		{/if}
	</Screen>
{/if}

<TaskSheet open={sheetTask !== null} task={sheetTask} onclose={() => (sheetTask = null)} />

<style>
	.group-heading {
		margin: 18px 2px 8px;
	}

	.group-heading.overdue {
		color: var(--danger);
	}
</style>
