import { createFileRoute } from "@tanstack/react-router";

import { HomePage } from "#/components/HomePage";

/** Home. Client-only: every screen renders from the IndexedDB Replica. */
export const Route = createFileRoute("/")({ ssr: false, component: HomePage });
