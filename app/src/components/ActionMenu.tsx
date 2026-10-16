import { Dialog, DialogContent, DialogHiddenTitle } from "./ui/dialog";

export interface MenuAction {
	label: string;
	danger?: boolean;
	/** Radio-style rows (Sort By): ✓ marks the current choice. */
	checked?: boolean;
	action: () => void;
}

interface ActionMenuProps {
	open: boolean;
	title?: string;
	actions: MenuAction[];
	onClose: () => void;
}

/** iOS action sheet: the per-list "…" menu and its Sort By picker. */
export function ActionMenu({
	open,
	title = "",
	actions,
	onClose,
}: ActionMenuProps) {
	function run(a: MenuAction): void {
		onClose();
		a.action();
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="menu-overlay" role="menu">
				<DialogHiddenTitle>{title || "Options"}</DialogHiddenTitle>
				<button
					type="button"
					className="scrim"
					aria-label="Close menu"
					onClick={onClose}
				/>
				<div className="menu-sheet">
					<div className="menu-group">
						{title && <div className="menu-title">{title}</div>}
						{actions.map((a) => {
							const className = a.danger ? "menu-item danger" : "menu-item";
							return a.checked === undefined ? (
								<button
									type="button"
									key={a.label}
									className={className}
									onClick={() => run(a)}
								>
									{a.label}
								</button>
							) : (
								<button
									type="button"
									key={a.label}
									className={className}
									role="menuitemradio"
									aria-checked={a.checked}
									onClick={() => run(a)}
								>
									<span className="tick" aria-hidden="true">
										{a.checked ? "✓" : ""}
									</span>
									{a.label}
								</button>
							);
						})}
					</div>
					<div className="menu-group">
						<button
							type="button"
							className="menu-item cancel"
							onClick={onClose}
						>
							Cancel
						</button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
