import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import type { ReactNode } from "react";

import { AppGate } from "#/components/AppGate";
import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";
import appCss from "../styles.css?url";

interface RouterContext {
	queryClient: QueryClient;
}

/**
 * The document and the app gate. The server renders only this root, as a
 * client-only shell (TSS_SHELL in vite.config.ts): every screen renders from
 * the IndexedDB Replica, and the service worker serves this same shell for
 * every navigation, offline included. Head tags match the Svelte build's
 * app.html (iOS standalone chrome, theme colours, icons, web manifest).
 */
export const Route = createRootRouteWithContext<RouterContext>()({
	head: () => ({
		meta: [
			{ charSet: "utf-8" },
			{
				name: "viewport",
				// maximum-scale=1 avoids iOS zoom traps on focused inputs;
				// viewport-fit=cover exposes the safe-area insets in standalone mode.
				content:
					"width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1",
			},
			{
				name: "theme-color",
				media: "(prefers-color-scheme: light)",
				content: "#f2f2f7",
			},
			{
				name: "theme-color",
				media: "(prefers-color-scheme: dark)",
				content: "#000000",
			},
			{
				name: "description",
				content:
					"Reminders-style tasks for the household, backed by Nextcloud.",
			},
			{ name: "mobile-web-app-capable", content: "yes" },
			{ name: "apple-mobile-web-app-capable", content: "yes" },
			{
				name: "apple-mobile-web-app-status-bar-style",
				content: "black-translucent",
			},
			{ name: "apple-mobile-web-app-title", content: "Tasks" },
			{ title: "Tasks" },
		],
		links: [
			{ rel: "stylesheet", href: appCss },
			{ rel: "icon", href: "/favicon.png?v=2" },
			{ rel: "apple-touch-icon", href: "/apple-touch-icon.png?v=2" },
			// vite-plugin-pwa writes the manifest; there is no index.html for it
			// to inject this tag into.
			{ rel: "manifest", href: "/manifest.webmanifest" },
		],
	}),
	shellComponent: RootDocument,
	component: RootLayout,
});

function RootLayout() {
	return (
		<AppGate>
			<Outlet />
		</AppGate>
	);
}

function RootDocument({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				{children}
				{import.meta.env.DEV && (
					<TanStackDevtools
						config={{ position: "bottom-right" }}
						plugins={[
							{
								name: "TanStack Router",
								render: <TanStackRouterDevtoolsPanel />,
							},
							TanStackQueryDevtools,
						]}
					/>
				)}
				<Scripts />
			</body>
		</html>
	);
}
