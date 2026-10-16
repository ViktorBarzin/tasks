import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { createTask, deleteTask, moveTask, updateTask } from "#/client/actions";
import { dueToInputs, inputsToDue, todayKey } from "#/client/dates";
import { replica } from "#/client/replica";
import type { Priority, Task, TaskFields } from "#/client/types";
import { useStore } from "#/client/useStore";
import { sortedLists } from "#/client/views";

import { AlertPrompt } from "./AlertPrompt";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

interface TaskSheetProps {
	open: boolean;
	/** Edit mode when set; create mode otherwise. */
	task?: Task | null;
	defaultListId?: string;
	defaultDue?: string | null;
	/** Create mode: prefill from a quick-add draft. */
	defaultTitle?: string;
	defaultPriority?: Priority;
	/** Fired after the sheet actually saved (created/updated), before onClose. */
	onSaved?: () => void;
	onClose: () => void;
}

const PRIORITIES: { value: Priority; label: string }[] = [
	{ value: 0, label: "None" },
	{ value: 9, label: "Low" },
	{ value: 5, label: "Medium" },
	{ value: 1, label: "High" },
];

const REPEAT_PATHS = [
	"M17 2l4 4-4 4",
	"M3 11v-1a4 4 0 0 1 4-4h14",
	"M7 22l-4-4 4-4",
	"M21 13v1a4 4 0 0 1-4 4H3",
];

/**
 * The task detail sheet (edit) / New Task sheet (create): title, notes, due
 * date + optional time, priority segmented control, List picker, read-only
 * repeat badge, delete. Saving diffs against the original and emits the
 * minimal Ops (task_update / task_move / task_create).
 */
export function TaskSheet({
	open,
	task = null,
	defaultListId = "",
	defaultDue = null,
	defaultTitle = "",
	defaultPriority = 0,
	onSaved,
	onClose,
}: TaskSheetProps) {
	const state = useStore(replica);
	const lists = useMemo(() => sortedLists(state), [state]);

	const [title, setTitle] = useState("");
	const [notes, setNotes] = useState("");
	const [date, setDate] = useState("");
	const [time, setTime] = useState("");
	const [priority, setPriority] = useState<Priority>(0);
	const [listId, setListId] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);
	const priorityGroup = useId();

	// Initialise the form on each open, from the props of that moment.
	const wasOpen = useRef(false);
	useLayoutEffect(() => {
		if (open && !wasOpen.current) {
			setConfirmDelete(false);
			if (task) {
				setTitle(task.title);
				setNotes(task.notes);
				const inputs = dueToInputs(task);
				setDate(inputs.date);
				setTime(inputs.time);
				setPriority(task.priority);
				setListId(task.list_id);
			} else {
				setTitle(defaultTitle);
				setNotes("");
				setDate(defaultDue ? defaultDue.slice(0, 10) : "");
				setTime("");
				setPriority(defaultPriority);
				setListId(defaultListId || lists[0]?.id || "");
			}
		}
		wasOpen.current = open;
	}, [
		open,
		task,
		defaultTitle,
		defaultDue,
		defaultPriority,
		defaultListId,
		lists,
	]);

	const canSave = title.trim().length > 0 && listId !== "";

	async function save(): Promise<void> {
		if (!canSave) return;
		const { due, due_has_time } = inputsToDue(date, time);
		if (task) {
			const patch: Partial<TaskFields> = {};
			const t = title.trim();
			if (t !== task.title) patch.title = t;
			if (notes !== task.notes) patch.notes = notes;
			if (due !== task.due || due_has_time !== task.due_has_time) {
				patch.due = due;
				patch.due_has_time = due_has_time;
			}
			if (priority !== task.priority) patch.priority = priority;
			if (Object.keys(patch).length) await updateTask(task.uid, patch);
			if (listId && listId !== task.list_id)
				await moveTask(task.uid, listId, task.list_id);
		} else {
			// One task_create op carrying the full field set (contract v1.2 §3).
			await createTask(listId, {
				title: title.trim(),
				notes,
				due,
				due_has_time,
				priority,
			});
		}
		onSaved?.();
		onClose();
	}

	async function removeTask(): Promise<void> {
		if (!task) return;
		setConfirmDelete(false);
		await deleteTask(task.uid);
		onClose();
	}

	function setRelativeDate(offsetDays: number): void {
		const d = new Date();
		d.setDate(d.getDate() + offsetDays);
		setDate(todayKey(d));
	}

	function clearDue(): void {
		setDate("");
		setTime("");
	}

	return (
		<>
			<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
				<DialogContent
					className="sheet-overlay"
					aria-label={task ? "Task details" : "New task"}
				>
					<button
						type="button"
						className="scrim"
						aria-label="Close"
						onClick={onClose}
					/>
					<div className="sheet">
						<div className="grabber" aria-hidden="true" />
						<header>
							<button type="button" className="hdr-btn" onClick={onClose}>
								Cancel
							</button>
							<DialogTitle>{task ? "Details" : "New Task"}</DialogTitle>
							<button
								type="button"
								className="hdr-btn strong"
								disabled={!canSave}
								onClick={() => void save()}
							>
								{task ? "Done" : "Add"}
							</button>
						</header>

						<div className="sheet-scroll">
							<div className="group">
								<input
									className="row-input title-input"
									value={title}
									onChange={(e) => setTitle(e.target.value)}
									placeholder="Title"
									type="text"
									autoCapitalize="sentences"
									enterKeyHint="done"
								/>
								<textarea
									className="row-input notes-input"
									value={notes}
									onChange={(e) => setNotes(e.target.value)}
									placeholder="Notes"
									rows={3}
								/>
							</div>

							<div className="group">
								<div className="form-row">
									<span className="row-label">Date</span>
									<input
										className="picker"
										type="date"
										aria-label="Date"
										value={date}
										onChange={(e) => setDate(e.target.value)}
									/>
								</div>
								<div className={date ? "form-row" : "form-row disabled"}>
									<span className="row-label">Time</span>
									<input
										className="picker"
										type="time"
										aria-label="Time"
										value={time}
										onChange={(e) => setTime(e.target.value)}
										disabled={!date}
									/>
								</div>
								<div className="chip-row">
									<button
										type="button"
										className="chip"
										onClick={() => setRelativeDate(0)}
									>
										Today
									</button>
									<button
										type="button"
										className="chip"
										onClick={() => setRelativeDate(1)}
									>
										Tomorrow
									</button>
									{date && (
										<button
											type="button"
											className="chip clear"
											onClick={clearDue}
										>
											No Date
										</button>
									)}
								</div>
							</div>

							<div className="group">
								<div className="form-row">
									<span className="row-label">Priority</span>
								</div>
								<fieldset className="segments">
									<legend className="sr-only">Priority</legend>
									{PRIORITIES.map((p) => (
										<label
											key={p.value}
											className={
												priority === p.value ? "segment selected" : "segment"
											}
										>
											<input
												type="radio"
												className="sr-only"
												name={priorityGroup}
												value={p.value}
												checked={priority === p.value}
												onChange={() => setPriority(p.value)}
											/>
											{p.label}
										</label>
									))}
								</fieldset>
							</div>

							<div className="group">
								<div className="form-row">
									<span className="row-label">List</span>
									<select
										className="picker"
										aria-label="List"
										value={listId}
										onChange={(e) => setListId(e.target.value)}
									>
										{lists.map((l) => (
											<option key={l.id} value={l.id}>
												{l.name}
											</option>
										))}
									</select>
								</div>
								{task?.recurring && (
									<div className="form-row repeat-row">
										<span className="row-label">
											<svg
												width="14"
												height="14"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2.2"
												strokeLinecap="round"
												strokeLinejoin="round"
												aria-hidden="true"
											>
												{REPEAT_PATHS.map((d) => (
													<path key={d} d={d} />
												))}
											</svg>
											Repeats
										</span>
										<span className="repeat-note">
											Completing schedules the next occurrence · edit the rule
											in Nextcloud
										</span>
									</div>
								)}
							</div>

							{task && (
								<div className="group">
									<button
										type="button"
										className="delete-btn"
										onClick={() => setConfirmDelete(true)}
									>
										Delete Task
									</button>
								</div>
							)}
						</div>
					</div>
				</DialogContent>
			</Dialog>

			<AlertPrompt
				open={confirmDelete}
				title="Delete Task?"
				message={`“${task?.title ?? ""}” will be deleted from Nextcloud too.`}
				confirmLabel="Delete"
				danger
				onConfirm={() => void removeTask()}
				onCancel={() => setConfirmDelete(false)}
			/>
		</>
	);
}
