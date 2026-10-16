import type { CSSProperties } from "react";

import { completeTask, uncompleteTask } from "#/client/actions";
import { formatDueChip, isOverdue } from "#/client/dates";
import type { Task } from "#/client/types";
import { swipeComplete } from "#/client/ui/swipe";

import { useAction } from "./useAction";

interface TaskRowProps {
	task: Task;
	now: Date;
	tint?: string;
	/** Extra context line (list name in Smart Views / search). */
	caption?: string;
	onOpen: () => void;
}

const PRIO_MARK: Record<number, string> = { 1: "!!!", 5: "!!", 9: "!" };

/**
 * One Task row, Reminders-close: round checkbox (tap to complete, with a
 * strike animation and a grace period before the row leaves open views),
 * !/!!/!!! priority marks, notes preview, due chip (red when overdue),
 * repeat glyph for Recurring Tasks, swipe-right-to-complete.
 */
export function TaskRow({
	task,
	now,
	tint = "var(--ios-accent)",
	caption,
	onOpen,
}: TaskRowProps) {
	const overdue = isOverdue(task, now);
	const swipe = useAction(swipeComplete, {
		oncommit: () => {
			if (!task.completed) void completeTask(task.uid);
		},
		enabled: !task.completed,
	});

	function toggle(): void {
		if (task.completed) void uncompleteTask(task.uid);
		else void completeTask(task.uid);
	}

	return (
		<div className="row-wrap">
			<div className="swipe-under" aria-hidden="true">
				<svg
					aria-hidden="true"
					width="22"
					height="22"
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
			<div className={task.completed ? "row completed" : "row"} ref={swipe}>
				<button
					type="button"
					className={task.completed ? "check on" : "check"}
					style={{ "--tint": tint } as CSSProperties}
					onClick={toggle}
					aria-label={task.completed ? "Mark incomplete" : "Mark complete"}
				>
					<span className="dot" />
				</button>
				<button type="button" className="body" onClick={onOpen}>
					<span className="title-line">
						{task.priority !== 0 && (
							<span className="prio" style={{ color: tint }}>
								{PRIO_MARK[task.priority]}
							</span>
						)}
						<span className="title">{task.title}</span>
					</span>
					{task.notes && (
						<span className="notes">{task.notes.split("\n")[0]}</span>
					)}
					{(task.due || task.recurring || caption) && (
						<span className="meta">
							{task.due && (
								<span className={overdue ? "due overdue" : "due"}>
									{formatDueChip(task, now)}
								</span>
							)}
							{task.recurring && (
								<svg
									className="repeat"
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.2"
									strokeLinecap="round"
									strokeLinejoin="round"
									role="img"
									aria-label="Repeats"
								>
									<path d="M17 2l4 4-4 4" />
									<path d="M3 11v-1a4 4 0 0 1 4-4h14" />
									<path d="M7 22l-4-4 4-4" />
									<path d="M21 13v1a4 4 0 0 1-4 4H3" />
								</svg>
							)}
							{caption && <span className="caption">{caption}</span>}
						</span>
					)}
				</button>
			</div>
		</div>
	);
}
