import { Dialog as DialogPrimitive, VisuallyHidden } from "radix-ui";
import type * as React from "react";

import { cn } from "#/lib/utils";

/**
 * shadcn/ui's Dialog, trimmed to the parts this app uses. The Radix
 * primitive brings the behaviour (focus trap, Escape, scroll lock, inert
 * background, exit animations through `data-state`); the look comes from
 * the caller's classes (components/tasks.css), because the app keeps the
 * Svelte build's iOS sheets and alerts instead of shadcn's centred card.
 *
 * DialogContent fills the viewport and is the overlay: callers put their own
 * scrim button and panel inside it, as the Svelte components did.
 */
function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
	return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogContent({
	className,
	children,
	...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
	return (
		<DialogPrimitive.Portal data-slot="dialog-portal">
			<DialogPrimitive.Content
				data-slot="dialog-content"
				className={cn(className)}
				// The app never auto-focuses into a sheet (it would raise the iOS
				// keyboard); callers focus a field themselves where they want one.
				onOpenAutoFocus={(e) => e.preventDefault()}
				aria-describedby={undefined}
				{...props}
			>
				{children}
			</DialogPrimitive.Content>
		</DialogPrimitive.Portal>
	);
}

function DialogTitle(
	props: React.ComponentProps<typeof DialogPrimitive.Title>,
) {
	return <DialogPrimitive.Title data-slot="dialog-title" {...props} />;
}

/** A title for screen readers only, for panels with no visible heading. */
function DialogHiddenTitle({ children }: { children: React.ReactNode }) {
	return (
		<VisuallyHidden.Root asChild>
			<DialogPrimitive.Title>{children}</DialogPrimitive.Title>
		</VisuallyHidden.Root>
	);
}

export { Dialog, DialogContent, DialogHiddenTitle, DialogTitle };
