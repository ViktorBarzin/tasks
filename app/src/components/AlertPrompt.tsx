import { type KeyboardEvent, useLayoutEffect, useRef, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

interface AlertPromptProps {
	open: boolean;
	title: string;
	message?: string;
	confirmLabel: string;
	danger?: boolean;
	withInput?: boolean;
	placeholder?: string;
	initial?: string;
	/** Typed confirm: the input must equal this exactly before confirm enables
	 * (destructive list delete). Implies withInput. */
	requireMatch?: string;
	onConfirm: (value: string) => void;
	onCancel: () => void;
}

/**
 * iOS-style alert: a confirm (optionally destructive) or a single text prompt
 * (list create / rename). The Svelte build's Dialog.svelte.
 */
export function AlertPrompt({
	open,
	title,
	message = "",
	confirmLabel,
	danger = false,
	withInput = false,
	placeholder = "",
	initial = "",
	requireMatch = "",
	onConfirm,
	onCancel,
}: AlertPromptProps) {
	const [value, setValue] = useState("");
	const input = useRef<HTMLInputElement | null>(null);
	const wasOpen = useRef(false);

	// Reset to `initial` on each open (not on every prop change while open).
	useLayoutEffect(() => {
		if (open && !wasOpen.current) {
			setValue(initial);
			const timer = setTimeout(() => input.current?.select(), 60);
			wasOpen.current = true;
			return () => clearTimeout(timer);
		}
		wasOpen.current = open;
	}, [open, initial]);

	const hasInput = withInput || requireMatch !== "";
	const confirmDisabled =
		hasInput &&
		(requireMatch !== "" ? value.trim() !== requireMatch : value.trim() === "");

	function confirm(): void {
		if (confirmDisabled) return;
		onConfirm(value.trim());
	}

	function onKeyDown(e: KeyboardEvent): void {
		if (e.key === "Enter") {
			e.preventDefault();
			confirm();
		}
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
			<DialogContent
				className="alert-overlay"
				role="alertdialog"
				onKeyDown={onKeyDown}
			>
				<button
					type="button"
					className="scrim"
					aria-label="Cancel"
					onClick={onCancel}
				/>
				<div className="alert">
					<div className="alert-body">
						<DialogTitle>{title}</DialogTitle>
						{message && <p>{message}</p>}
						{hasInput && (
							<input
								ref={input}
								value={value}
								onChange={(e) => setValue(e.target.value)}
								placeholder={placeholder}
								className="prompt"
								type="text"
								autoCapitalize="words"
								enterKeyHint="done"
							/>
						)}
					</div>
					<div className="alert-buttons">
						<button type="button" className="alert-btn" onClick={onCancel}>
							Cancel
						</button>
						<button
							type="button"
							className={
								danger ? "alert-btn strong danger" : "alert-btn strong"
							}
							disabled={confirmDisabled}
							onClick={confirm}
						>
							{confirmLabel}
						</button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
