import { createFileRoute } from "@tanstack/react-router";

import { ListPage } from "#/components/ListPage";

/** One List's screen. Client-only: rendered from the IndexedDB Replica. */
export const Route = createFileRoute("/list/$id")({
	ssr: false,
	component: ListRoute,
});

function ListRoute() {
	const { id } = Route.useParams();
	// Keyed by id so per-List state (search, menus, drafts) resets on a switch.
	return <ListPage key={id} listId={id} />;
}
