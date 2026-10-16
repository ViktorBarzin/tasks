import type { FormEvent } from "react";

import type { Priority } from "#/client/types";

interface QuickAddProps {
	placeholder?: string;
	/** The draft title (controlled: survives an expand round trip). */
	text: string;
	onTextChange: (text: string) => void;
	/** The draft priority (controlled). */
	priority: Priority;
	onPriorityChange: (priority: Priority) => void;
	onAdd: (fields: { title: string; priority: Priority }) => Promise<unknown>;
	/** Open the full New-Task sheet with the current draft. */
	onExpand?: () => void;
}

/** Tap-to-cycle escalation: None → ! (Low 9) → !! (Medium 5) → !!! (High 1). */
const CYCLE: Record<Priority, Priority> = { 0: 9, 9: 5, 5: 1, 1: 0 };
const MARK: Record<Priority, string> = { 0: "!", 9: "!", 5: "!!", 1: "!!!" };
const NAME: Record<Priority, string> = {
	0: "None",
	9: "Low",
	5: "Medium",
	1: "High",
};

/**
 * The quick-add row pinned at the bottom of task screens: type, hit return,
 * the task lands in the current context (list / due) instantly. A compact
 * priority control rides in the row, and the expand chevron hands the draft
 * to the full New-Task sheet for notes / due / list. The parent owns the
 * draft so it survives the sheet round trip and clears once the sheet creates.
 */
export function QuickAdd({
	placeholder = "New Task",
	text,
	onTextChange,
	priority,
	onPriorityChange,
	onAdd,
	onExpand,
}: QuickAddProps) {
	async function commit(e: FormEvent<HTMLFormElement>): Promise<void> {
		e.preventDefault();
		const title = text.trim();
		if (!title) return;
		const fields = { title, priority };
		onTextChange("");
		onPriorityChange(0);
		await onAdd(fields);
	}

	return (
		<form className="quick-add" onSubmit={(e) => void commit(e)}>
			<span className="plus" aria-hidden="true">
				<svg
					aria-hidden="true"
					width="20"
					height="20"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.2"
					strokeLinecap="round"
				>
					<path d="M12 5v14M5 12h14" />
				</svg>
			</span>
			<input
				value={text}
				onChange={(e) => onTextChange(e.target.value)}
				placeholder={placeholder}
				type="text"
				enterKeyHint="done"
				autoComplete="off"
				autoCapitalize="sentences"
				aria-label="New task title"
			/>
			<button
				type="button"
				className={priority !== 0 ? "prio set" : "prio"}
				aria-label={`Priority: ${NAME[priority]}`}
				title={`Priority: ${NAME[priority]}`}
				onClick={() => onPriorityChange(CYCLE[priority])}
			>
				{MARK[priority]}
			</button>
			{onExpand && (
				<button
					type="button"
					className="expand"
					aria-label="More options"
					onClick={onExpand}
				>
					<svg
						aria-hidden="true"
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.4"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M5 15l7-7 7 7" />
					</svg>
				</button>
			)}
		</form>
	);
}
