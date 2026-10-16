import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { syncNow } from "#/client/sync";
import { pullToRefresh } from "#/client/ui/pullToRefresh";

import { StatusPills } from "./StatusPills";
import { useAction } from "./useAction";

interface ScreenProps {
	title: string;
	tint?: string;
	back?: { href: string; label: string };
	/** Switch pull-to-refresh off while a mode owns the touch stream (Edit-mode drag). */
	refreshDisabled?: boolean;
	right?: ReactNode;
	bottom?: ReactNode;
	children: ReactNode;
}

/**
 * The screen shell every page uses: fixed nav bar (back link, status pills,
 * per-screen actions), an inner scroller with pull-to-refresh (the page
 * itself never scrolls), and an optional bottom bar above the home-indicator
 * safe area.
 */
export function Screen({
	title,
	tint,
	back,
	refreshDisabled = false,
	right,
	bottom,
	children,
}: ScreenProps) {
	const scroller = useAction(pullToRefresh, {
		onrefresh: () => syncNow(),
		enabled: !refreshDisabled,
	});
	return (
		<div className="screen">
			<header className="navbar">
				<div className="nav-side left">
					{back && (
						<Link className="back" to={back.href}>
							<svg
								width="13"
								height="20"
								viewBox="0 0 13 20"
								fill="none"
								aria-hidden="true"
							>
								<path
									d="M11 2 3 10l8 8"
									stroke="currentColor"
									strokeWidth="2.4"
									strokeLinecap="round"
									strokeLinejoin="round"
								/>
							</svg>
							{back.label}
						</Link>
					)}
				</div>
				<div className="nav-side right">
					<StatusPills />
					{right}
				</div>
			</header>

			<div className="scroller" ref={scroller}>
				<div className="ptr" aria-hidden="true">
					<span className="ptr-spinner" />
				</div>
				<h1 className="large-title" style={{ color: tint ?? "inherit" }}>
					{title}
				</h1>
				{children}
				<div className="tail-space" />
			</div>

			{bottom && <div className="bottombar">{bottom}</div>}
		</div>
	);
}
