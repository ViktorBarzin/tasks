/**
 * The wire types the client modules use, re-exported from the shared contract
 * under the names the Svelte build used (frontend/src/lib/types.ts).
 */
export type * from "#/shared/contract";
export type {
	MeResponse as Me,
	Op,
	OpKind,
	OpResult,
	OpStatus,
	OpsResponse,
	Priority,
	SortMode,
	SyncResponse as SyncPayload,
	Task,
	TaskFields,
	TaskList,
} from "#/shared/contract";
