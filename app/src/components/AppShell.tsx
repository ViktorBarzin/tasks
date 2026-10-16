import { useState } from "react";

import { Button } from "#/components/ui/button";

/**
 * Placeholder shell for the port. The real UI (lists, smart views, task
 * sheet) replaces this; it exists so the build, hydration and component tests
 * have something real to exercise.
 */
export function AppShell() {
	const [taps, setTaps] = useState(0);
	return (
		<main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-4 p-6">
			<h1 className="text-3xl font-semibold">Tasks</h1>
			<p className="text-muted-foreground">
				TypeScript port in progress. The live app is unchanged.
			</p>
			<div className="flex items-center gap-3">
				<Button onClick={() => setTaps((n) => n + 1)}>Tap</Button>
				<span data-testid="taps">{taps}</span>
			</div>
		</main>
	);
}
