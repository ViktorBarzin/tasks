<script lang="ts">
	/**
	 * One List's screen: its Tasks off the Replica (completed section
	 * toggleable, search-filterable), quick-add into this List, and the "…"
	 * menu with the List lifecycle — rename, and delete behind a typed-confirm
	 * (Nextcloud's calendar trashbin is the recovery net, ADR/design §10).
	 */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import { createTask, deleteList, recentlyCompleted, renameList } from '$lib/actions';
	import ActionMenu from '$lib/components/ActionMenu.svelte';
	import CompletedBar from '$lib/components/CompletedBar.svelte';
	import Dialog from '$lib/components/Dialog.svelte';
	import QuickAdd from '$lib/components/QuickAdd.svelte';
	import Screen from '$lib/components/Screen.svelte';
	import TaskRow from '$lib/components/TaskRow.svelte';
	import TaskSheet from '$lib/components/TaskSheet.svelte';
	import { replica, replicaLoaded } from '$lib/replica';
	import type { Priority, Task } from '$lib/types';
	import { now } from '$lib/ui/clock';
	import { listColor } from '$lib/ui/listColors';
	import { buildListView, filterTasks } from '$lib/views';

	let listId = $derived(page.params.id ?? '');
	let list = $derived($replica.lists.get(listId));
	let tint = $derived(listColor(listId));

	let query = $state('');
	let showCompleted = $state(false);
	let sheetTask = $state<Task | null>(null);
	let menuOpen = $state(false);
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

	let rows = $derived(
		filterTasks(
			buildListView($replica, listId, { showCompleted, now: $now, grace: $recentlyCompleted }),
			query
		)
	);
	let completedCount = $derived(
		buildListView($replica, listId, { showCompleted: true, now: $now }).filter(
			(t) => t.completed
		).length
	);

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

		{#if rows.length === 0}
			<p class="empty">
				{query.trim() ? `No results for “${query.trim()}”` : 'No Tasks — add one below.'}
			</p>
		{:else}
			<div class="card hairline-rows">
				{#each rows as t (t.uid)}
					<TaskRow task={t} now={$now} {tint} onopen={() => (sheetTask = t)} />
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
		{ label: 'Rename List', action: () => (renameOpen = true) },
		{ label: 'Delete List', danger: true, action: () => (deleteOpen = true) }
	]}
	onclose={() => (menuOpen = false)}
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
</style>
