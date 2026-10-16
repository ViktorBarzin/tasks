import { type FormEvent, useEffect, useState } from "react";

import { ApiError, AuthWallError, api } from "#/client/api";
import { signIn } from "#/client/signin";

interface OnboardingProps {
	/** The signed-in username, prefilled as the likely Nextcloud username. */
	username?: string;
	reconnect?: boolean;
	onDone: () => void;
	onCancel?: (() => void) | null;
}

/**
 * Onboarding (tasks ADR-0002): the user proves their Nextcloud credential;
 * the server live-validates it against CalDAV before storing it encrypted.
 * Also the re-onboarding path when the app password is revoked (the
 * reconnect banner opens it).
 */
export function Onboarding({
	username = "",
	reconnect = false,
	onDone,
	onCancel = null,
}: OnboardingProps) {
	// Prefills from the username (and follows a late identity fetch) while
	// staying editable: the likely Nextcloud username matches.
	const [ncUsername, setNcUsername] = useState(username);
	useEffect(() => setNcUsername(username), [username]);
	const [appPassword, setAppPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const canSubmit =
		ncUsername.trim() !== "" && appPassword.trim() !== "" && !busy;

	async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
		e.preventDefault();
		if (!canSubmit) return;
		setBusy(true);
		setError(null);
		try {
			await api.onboard(ncUsername.trim(), appPassword.trim());
			setAppPassword("");
			onDone();
		} catch (err) {
			if (err instanceof AuthWallError) {
				// The session lapsed mid-onboarding: the popup re-runs sign-in
				// without discarding the credentials just typed.
				setError(
					"Your sign-in ran out — finish signing in, then press Connect again.",
				);
				void signIn();
				return;
			}
			if (err instanceof ApiError && err.status === 401) {
				setError(
					"Nextcloud rejected those credentials. Check the username and paste a fresh app password.",
				);
			} else if (err instanceof ApiError) {
				setError(
					`Something went wrong on the server (${err.status}). Try again in a moment.`,
				);
			} else {
				setError(
					"Could not reach the server. Connect to the internet and try again.",
				);
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="onboard">
			<div className="inner">
				<div className="mark" aria-hidden="true">
					<svg
						aria-hidden="true"
						width="34"
						height="34"
						viewBox="0 0 24 24"
						fill="none"
						stroke="#fff"
						strokeWidth="3"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M4.5 12.5 10 18 19.5 7" />
					</svg>
				</div>
				<h1>{reconnect ? "Reconnect Nextcloud" : "Connect Nextcloud"}</h1>
				<p className="lede">
					{reconnect ? (
						"Nextcloud stopped accepting the stored app password — it was probably revoked or rotated. Paste a fresh one to carry on."
					) : (
						<>
							Your tasks live in Nextcloud. Paste your Nextcloud username and an{" "}
							<strong>app password</strong> so Tasks can sync them.
						</>
					)}
				</p>

				<form onSubmit={(e) => void submit(e)}>
					<label>
						<span>Nextcloud username</span>
						<input
							className="field"
							type="text"
							value={ncUsername}
							onChange={(e) => setNcUsername(e.target.value)}
							autoComplete="username"
							autoCapitalize="none"
							spellCheck={false}
							placeholder="username"
						/>
					</label>
					<label>
						<span>App password</span>
						<input
							className="field"
							type="password"
							value={appPassword}
							onChange={(e) => setAppPassword(e.target.value)}
							autoComplete="current-password"
							placeholder="xxxxx-xxxxx-xxxxx-xxxxx-xxxxx"
						/>
					</label>

					{error && (
						<p className="error" role="alert">
							{error}
						</p>
					)}

					<button className="connect" type="submit" disabled={!canSubmit}>
						{busy
							? "Checking with Nextcloud…"
							: reconnect
								? "Reconnect"
								: "Connect"}
					</button>
					{onCancel && (
						<button className="cancel" type="button" onClick={onCancel}>
							Not now
						</button>
					)}
				</form>

				<p className="hint">
					Create one in Nextcloud under{" "}
					<strong>Settings → Security → Devices &amp; sessions</strong>. It is
					verified live against CalDAV and stored encrypted — your account
					password is never asked for.
				</p>
			</div>
		</div>
	);
}
