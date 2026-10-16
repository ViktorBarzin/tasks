interface CompletedBarProps {
	count: number;
	shown: boolean;
	onToggle: () => void;
}

/**
 * The completed-section toggle every task screen carries under its title:
 * "N Completed · Show/Hide". Hidden while there is nothing completed to show.
 */
export function CompletedBar({ count, shown, onToggle }: CompletedBarProps) {
	if (count === 0 && !shown) return null;
	return (
		<div className="completed-bar">
			<span className="count">{count} Completed</span>
			<button type="button" className="toggle" onClick={onToggle}>
				{shown ? "Hide" : "Show"}
			</button>
		</div>
	);
}
