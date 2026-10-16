import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import {
	AccessPendingError,
	AuthWallError,
	api,
	clientId,
	PENDING_PATH,
} from "#/client/api";
import * as db from "#/client/db";
import { scheduleSwUpdates } from "#/client/pwa";
import { startLiveUpdates } from "#/client/realtime";
import { startRelogin } from "#/client/relogin";
import { loadReplica, replica } from "#/client/replica";
import { signIn, signinFailed, signinPending } from "#/client/signin";
import { get } from "#/client/store";
import {
	accessPending,
	deadOps,
	needsLogin,
	needsReconnect,
	startSync,
	syncNow,
	syncStuck,
} from "#/client/sync";
import { useStore } from "#/client/useStore";

import { Onboarding } from "./Onboarding";

type Gate = "loading" | "onboard" | "app";

/** The Svelte build's re-login marker (tasks ADR-0003); tidied away if present. */
const LEGACY_RELOGIN_PARAM = "relogin";

async function registerServiceWorker(): Promise<void> {
	if (!("serviceWorker" in navigator)) return;
	// autoUpdate: the new worker swaps itself in when a deploy lands, and the
	// page reloads onto it. Poll hourly and on foreground so an installed PWA
	// doesn't pin a stale bundle (contract-delta §K).
	const { registerSW } = await import("virtual:pwa-register");
	registerSW({
		immediate: true,
		onRegisteredSW(_swUrl, registration) {
			if (registration) scheduleSwUpdates(registration);
		},
	});
}

function clearLegacyReloginMarker(): void {
	const url = new URL(window.location.href);
	if (!url.searchParams.has(LEGACY_RELOGIN_PARAM)) return;
	url.searchParams.delete(LEGACY_RELOGIN_PARAM);
	window.history.replaceState(window.history.state, "", url.href);
}

/** The component state the boot sequence drives (all stable setters). */
interface GateControls {
	setGate(gate: Gate): void;
	setFirstSync(on: boolean): void;
	setUsername(name: string): void;
}

function enterApp(ui: GateControls): void {
	ui.setGate("app");
	const { lists, tasks } = get(replica);
	const empty = lists.size === 0 && tasks.size === 0;
	ui.setFirstSync(empty);
	startSync();
	startLiveUpdates({
		syncNow,
		clientId,
		onSignedIn: (listener) => {
			needsLogin.subscribe((lapsed) => {
				if (!lapsed) listener();
			});
		},
	});
	if (empty) {
		// Progress for the initial full snapshot: syncNow coalesces into the
		// cycle startSync just kicked and resolves when it finishes, success or
		// not (offline resolves immediately; retries run in background).
		void syncNow().finally(() => ui.setFirstSync(false));
	}
}

/** Background /api/me probe: refresh the cached username; surface a lost
 * Connected Account as the reconnect banner. Offline → ignore. */
async function refreshIdentity(ui: GateControls): Promise<void> {
	try {
		const me = await api.me();
		ui.setUsername(me.username);
		await db.setMeta("username", me.username);
		if (!me.connected) needsReconnect.set(true);
	} catch (err) {
		// Offline or flaky: the Replica carries the session. A lapsed session is
		// different: say so now instead of waiting for a sync cycle.
		if (err instanceof AuthWallError) needsLogin.set(true);
		if (err instanceof AccessPendingError) accessPending.set(true);
	}
}

/** Launch: Replica first, then onboarding vs app (see AppGate). */
async function boot(ui: GateControls, cancelled: () => boolean): Promise<void> {
	await loadReplica();
	const cachedName = (await db.getMeta<string>("username")) ?? "";
	if (cancelled()) return;
	ui.setUsername(cachedName);

	if ((await db.getMeta<boolean>("connected")) ?? false) {
		if (cancelled()) return;
		enterApp(ui);
		void refreshIdentity(ui);
		return;
	}
	try {
		const me = await api.me();
		if (cancelled()) return;
		ui.setUsername(me.username);
		await db.setMeta("username", me.username);
		if (me.connected) {
			await db.setMeta("connected", true);
			enterApp(ui);
		} else {
			ui.setGate("onboard");
		}
	} catch (err) {
		if (cancelled()) return;
		if (err instanceof AccessPendingError) {
			accessPending.set(true);
			return;
		}
		if (err instanceof AuthWallError) {
			// Reachable, but there is no session and this device has nothing
			// cached to show. Asking for Nextcloud credentials here would be a
			// dead end; signing in is the only thing that can help.
			needsLogin.set(true);
			return;
		}
		// Unreachable server before this device ever onboarded: no Replica to
		// show, and onboarding needs the network anyway.
		ui.setGate("onboard");
	}
}

/**
 * The app gate (the Svelte build's +layout.svelte). Launch order: hydrate the
 * Replica (instant render from IndexedDB; the app must work with the network
 * cut), then decide onboarding vs app. A device that has onboarded before
 * goes straight in on the cached flag; /api/me is only awaited on first run.
 * A Nextcloud 401 from sync later flips needsReconnect → banner →
 * re-onboarding overlay; a lapsed session (401 `unauthorized`) flips
 * needsLogin → sign-in banner, or the sign-in wall when nothing is cached.
 */
export function AppGate({ children }: { children: ReactNode }) {
	const [gate, setGate] = useState<Gate>("loading");
	const gateRef = useRef<Gate>("loading");
	const [username, setUsername] = useState("");
	const [showReconnect, setShowReconnect] = useState(false);
	/** Entering the app with an empty Replica (fresh onboard / new device):
	 * cover the shell until the initial full sync lands. */
	const [firstSync, setFirstSync] = useState(false);

	const login = useStore(needsLogin);
	const reconnect = useStore(needsReconnect);
	const dead = useStore(deadOps);
	const stuck = useStore(syncStuck);
	const pending = useStore(signinPending);
	const failed = useStore(signinFailed);

	const ui = useMemo<GateControls>(
		() => ({
			setGate(next) {
				gateRef.current = next;
				setGate(next);
			},
			setFirstSync,
			setUsername,
		}),
		[],
	);

	useEffect(() => {
		let cancelled = false;
		void registerServiceWorker();
		clearLegacyReloginMarker();
		void boot(ui, () => cancelled);
		// Signed in but not approved (403 access_pending): the pending page
		// explains it and re-checks; the app itself cannot load data.
		const unsubscribe = accessPending.subscribe((waiting) => {
			if (waiting) window.location.assign(PENDING_PATH);
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [ui]);

	/**
	 * Sign in without tearing the app down (tasks ADR-0004): a popup carries
	 * the round trip. If that attempt ended without a session, the next tap
	 * takes the full-page path, which always reaches the sign-in page.
	 */
	function onSignInTap(): void {
		if (get(signinFailed)) void startRelogin();
		else void signIn();
	}

	async function onboarded(): Promise<void> {
		await db.setMeta("connected", true);
		needsReconnect.set(false);
		setShowReconnect(false);
		if (gateRef.current !== "app") enterApp(ui);
		else void syncNow();
	}

	let body: ReactNode;
	if (gate === "app") {
		body = (
			<>
				{login ? (
					<button
						type="button"
						className="reconnect-banner"
						onClick={onSignInTap}
						disabled={pending}
					>
						{pending ? (
							"Waiting for sign-in…"
						) : failed ? (
							<>
								Sign-in didn’t finish — <strong>sign in here</strong>
							</>
						) : (
							<>
								Session expired — <strong>sign in</strong>
							</>
						)}
					</button>
				) : (
					reconnect &&
					!showReconnect && (
						<button
							type="button"
							className="reconnect-banner"
							onClick={() => setShowReconnect(true)}
						>
							Nextcloud connection failed — <strong>Reconnect</strong>
						</button>
					)
				)}
				{dead > 0 ? (
					<output className="dead-banner">
						{dead} task{dead === 1 ? "" : "s"} couldn’t sync and{" "}
						{dead === 1 ? "was" : "were"} set aside.
					</output>
				) : (
					stuck && (
						<output className="stuck-banner">
							Having trouble syncing — still retrying…
						</output>
					)
				)}
				{children}
				{firstSync && (
					<output className="first-sync">
						<span className="boot-spin" />
						<p>Downloading your tasks from Nextcloud…</p>
					</output>
				)}
			</>
		);
	} else if (login) {
		// Nothing cached to show and no session: the sign-in wall is the whole
		// screen, not a banner over an empty app.
		body = (
			<div className="signin-wall">
				<h1>Session expired</h1>
				<p>
					{failed
						? "That sign-in window closed before it finished. This opens sign-in in the app instead."
						: "Your sign-in has run out. Sign in again to get your tasks back."}
				</p>
				<button
					type="button"
					className="signin-button"
					onClick={onSignInTap}
					disabled={pending}
				>
					{pending ? "Waiting for sign-in…" : "Sign in"}
				</button>
			</div>
		);
	} else if (gate === "onboard") {
		body = <Onboarding username={username} onDone={() => void onboarded()} />;
	} else {
		body = (
			<output className="boot" aria-label="Loading">
				<span className="boot-spin" />
			</output>
		);
	}

	return (
		<>
			<div className="app-shell">{body}</div>
			{showReconnect && (
				<div className="reconnect-overlay">
					<Onboarding
						username={username}
						reconnect
						onDone={() => void onboarded()}
						onCancel={() => setShowReconnect(false)}
					/>
				</div>
			)}
		</>
	);
}
