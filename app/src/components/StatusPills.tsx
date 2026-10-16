import { online, pendingOps, syncing } from "#/client/sync";
import { useStore } from "#/client/useStore";

import { Icon } from "./Icon";

const OFFLINE =
	"M3 3l18 18M9 5a10 10 0 0 1 11 3M5 9a10 10 0 0 1 2-1.5M8.5 12.5A6 6 0 0 1 12 11m4.5 1.5a6 6 0 0 1 1 1M12 19h.01";

/**
 * Offline indicator, pending-ops badge and sync spinner (every screen's nav
 * bar). Pending count > 0 while offline is the "your edits are safe, queued"
 * signal.
 */
export function StatusPills() {
	const isOnline = useStore(online);
	const pending = useStore(pendingOps);
	const isSyncing = useStore(syncing);
	return (
		<span className="pills">
			{!isOnline && (
				<span className="pill offline" title="Offline — changes are queued">
					<Icon path={OFFLINE} size={14} stroke={1.8} />
					Offline
				</span>
			)}
			{pending > 0 ? (
				<span
					className="pill pending"
					title={`${pending} unsynced change${pending === 1 ? "" : "s"}`}
				>
					{pending}
					<svg
						width="11"
						height="11"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.4"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M12 19V5m-6 6 6-6 6 6" />
					</svg>
				</span>
			) : (
				isSyncing && <output className="spin" aria-label="Syncing" />
			)}
		</span>
	);
}
