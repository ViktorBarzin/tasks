<script lang="ts">
	/** iOS-style alert: confirm (optionally destructive) or single text prompt
	 * (list create/rename). */
	import { untrack } from 'svelte';
	import { fade, scale } from 'svelte/transition';

	interface Props {
		open: boolean;
		title: string;
		message?: string;
		confirmLabel: string;
		danger?: boolean;
		withInput?: boolean;
		placeholder?: string;
		initial?: string;
		onconfirm: (value: string) => void;
		oncancel: () => void;
	}
	let {
		open,
		title,
		message = '',
		confirmLabel,
		danger = false,
		withInput = false,
		placeholder = '',
		initial = '',
		onconfirm,
		oncancel
	}: Props = $props();

	let value = $state('');
	let inputEl = $state<HTMLInputElement | null>(null);
	let wasOpen = false;

	$effect(() => {
		const isOpen = open;
		untrack(() => {
			if (isOpen && !wasOpen) {
				value = initial;
				setTimeout(() => inputEl?.select(), 60);
			}
			wasOpen = isOpen;
		});
	});

	let confirmDisabled = $derived(withInput && value.trim() === '');

	function confirm(): void {
		if (confirmDisabled) return;
		onconfirm(value.trim());
	}

	function onkeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter') {
			e.preventDefault();
			confirm();
		} else if (e.key === 'Escape') {
			oncancel();
		}
	}
</script>

{#if open}
	<div class="overlay" role="alertdialog" aria-modal="true" aria-label={title} onkeydown={onkeydown} tabindex="-1">
		<button class="scrim" aria-label="Cancel" onclick={oncancel} transition:fade={{ duration: 150 }}></button>
		<div class="alert" transition:scale={{ start: 1.08, duration: 180 }}>
			<div class="alert-body">
				<h2>{title}</h2>
				{#if message}<p>{message}</p>{/if}
				{#if withInput}
					<input
						bind:this={inputEl}
						bind:value
						{placeholder}
						class="prompt"
						type="text"
						autocapitalize="words"
						enterkeyhint="done"
					/>
				{/if}
			</div>
			<div class="alert-buttons">
				<button class="alert-btn" onclick={oncancel}>Cancel</button>
				<button
					class="alert-btn strong"
					class:danger
					disabled={confirmDisabled}
					onclick={confirm}>{confirmLabel}</button
				>
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		z-index: 60;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 24px;
	}

	.scrim {
		position: absolute;
		inset: 0;
		background: var(--sheet-scrim);
	}

	.alert {
		position: relative;
		width: min(280px, 100%);
		border-radius: 14px;
		background: var(--card);
		box-shadow: 0 10px 50px rgba(0, 0, 0, 0.3);
		overflow: hidden;
	}

	.alert-body {
		padding: 18px 16px 14px;
		text-align: center;
	}

	h2 {
		font-size: 17px;
		font-weight: 600;
		margin: 0 0 4px;
	}

	p {
		font-size: 13px;
		color: var(--fg-2);
		margin: 0;
	}

	.prompt {
		margin-top: 12px;
		width: 100%;
		border: 0.5px solid var(--hairline);
		border-radius: 8px;
		padding: 7px 10px;
		background: var(--bg);
		outline: none;
		font-size: 15px;
	}

	.alert-buttons {
		display: flex;
		border-top: 0.5px solid var(--hairline);
	}

	.alert-btn {
		flex: 1;
		padding: 12px 8px;
		font-size: 17px;
		color: var(--accent);
	}

	.alert-btn + .alert-btn {
		border-left: 0.5px solid var(--hairline);
	}

	.alert-btn.strong {
		font-weight: 600;
	}

	.alert-btn.danger {
		color: var(--danger);
	}

	.alert-btn:disabled {
		opacity: 0.4;
	}

	.alert-btn:active {
		background: var(--card-pressed);
	}
</style>
