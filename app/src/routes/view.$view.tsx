import { createFileRoute } from "@tanstack/react-router";

import { SmartViewPage } from "#/components/SmartViewPage";

/** A Smart View: today, scheduled or all. Unknown names go back Home. */
export const Route = createFileRoute("/view/$view")({
	ssr: false,
	component: SmartViewRoute,
});

function SmartViewRoute() {
	const { view } = Route.useParams();
	return <SmartViewPage key={view} view={view} />;
}
