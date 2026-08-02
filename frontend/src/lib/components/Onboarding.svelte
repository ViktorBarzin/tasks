<script lang="ts">
	/**
	 * Onboarding (ADR-0002): the user proves their Nextcloud credential — the
	 * server live-validates it against CalDAV before storing it encrypted.
	 * Also serves as the re-onboarding path when the app password is revoked
	 * (needsReconnect banner → here).
	 */
	import { api, ApiError, AuthWallError } from '$lib/api';
	import { startRelogin } from '$lib/relogin';

	interface Props {
		/** Authentik username, prefilled as the likely NC username. */
		username?: string;
		reconnect?: boolean;
		ondone: () => void;
		oncancel?: (() => void) | null;
	}
	let { username = '', reconnect = false, ondone, oncancel = null }: Props = $props();

	// Writable-derived: prefills from the Authentik username (and tracks a late
	// identity fetch) while staying editable — the likely NC username matches.
	let ncUsername = $derived(username);
	let appPassword = $state('');
	let busy = $state(false);
	let error = $state<string | null>(null);

	let canSubmit = $derived(ncUsername.trim() !== '' && appPassword.trim() !== '' && !busy);

	async function submit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (!canSubmit) return;
		busy = true;
		error = null;
		try {
			await api.onboard(ncUsername.trim(), appPassword.trim());
			appPassword = '';
			ondone();
		} catch (err) {
			if (err instanceof AuthWallError) {
				// SSO session lapsed while onboarding — a marked navigation re-runs
				// login (not the wrong "offline" message). §I.
				startRelogin();
				return;
			}
			if (err instanceof ApiError && err.status === 401) {
				error = 'Nextcloud rejected those credentials. Check the username and paste a fresh app password.';
			} else if (err instanceof ApiError) {
				error = `Something went wrong on the server (${err.status}). Try again in a moment.`;
			} else {
				error = 'Could not reach the server. Connect to the internet and try again.';
			}
		} finally {
			busy = false;
		}
	}
</script>

<div class="onboard">
	<div class="inner">
		<div class="mark" aria-hidden="true">
			<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5 10 18 19.5 7" /></svg>
		</div>
		<h1>{reconnect ? 'Reconnect Nextcloud' : 'Connect Nextcloud'}</h1>
		<p class="lede">
			{#if reconnect}
				Nextcloud stopped accepting the stored app password — it was probably revoked or
				rotated. Paste a fresh one to carry on.
			{:else}
				Your tasks live in Nextcloud. Paste your Nextcloud username and an <strong>app
				password</strong> so Tasks can sync them.
			{/if}
		</p>

		<form onsubmit={submit}>
			<label>
				<span>Nextcloud username</span>
				<input
					class="field"
					type="text"
					bind:value={ncUsername}
					autocomplete="username"
					autocapitalize="none"
					spellcheck="false"
					placeholder="username"
				/>
			</label>
			<label>
				<span>App password</span>
				<input
					class="field"
					type="password"
					bind:value={appPassword}
					autocomplete="current-password"
					placeholder="xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"
				/>
			</label>

			{#if error}<p class="error" role="alert">{error}</p>{/if}

			<button class="connect" type="submit" disabled={!canSubmit}>
				{busy ? 'Checking with Nextcloud…' : reconnect ? 'Reconnect' : 'Connect'}
			</button>
			{#if oncancel}
				<button class="cancel" type="button" onclick={oncancel}>Not now</button>
			{/if}
		</form>

		<p class="hint">
			Create one in Nextcloud under <strong>Settings → Security → Devices &amp; sessions</strong>.
			It is verified live against CalDAV and stored encrypted — your account password is never
			asked for.
		</p>
	</div>
</div>

<style>
	.onboard {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		display: flex;
		justify-content: center;
		padding: calc(env(safe-area-inset-top) + 40px) 24px calc(env(safe-area-inset-bottom) + 32px);
	}

	.inner {
		width: min(420px, 100%);
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
	}

	.mark {
		width: 72px;
		height: 72px;
		border-radius: 18px;
		background: linear-gradient(160deg, #4da3ff, #0a5fd6);
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 8px 24px rgba(10, 95, 214, 0.35);
	}

	h1 {
		font-size: 28px;
		font-weight: 700;
		margin: 18px 0 6px;
	}

	.lede {
		color: var(--fg-2);
		font-size: 15px;
		margin: 0 0 22px;
	}

	form {
		width: 100%;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	label {
		text-align: left;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	label span {
		font-size: 13px;
		font-weight: 600;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.connect {
		margin-top: 6px;
		background: var(--accent);
		color: #fff;
		font-size: 17px;
		font-weight: 600;
		border-radius: 12px;
		padding: 13px;
	}

	.connect:disabled {
		opacity: 0.5;
	}

	.cancel {
		color: var(--accent);
		padding: 8px;
	}

	.error {
		color: var(--danger);
		font-size: 14px;
		margin: 0;
		text-align: left;
	}

	.hint {
		margin-top: 26px;
		font-size: 13px;
		color: var(--muted);
	}
</style>
