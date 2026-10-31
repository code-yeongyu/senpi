/**
 * The public pending-input lifecycle (senpi#3549), exported as `@code-yeongyu/senpi/pending-input`: the one
 * reducer, its projection and closed types, and the store over an injected journal. Other owners (the desktop
 * server for native providers, the omo child prelaunch queue) embed this exact module instead of reimplementing
 * it. Re-exports only.
 */
export { reducePendingInput } from "./pending-input.ts";
export {
	type PendingInputAction,
	type PendingInputProjection,
	type PendingInputState,
	type PendingInputStatusCode,
	projectPendingInput,
} from "./pending-input-projection.ts";
export {
	PENDING_INPUT_TRANSITION,
	type PendingInputJournal,
	type PendingInputJournalRecord,
	type PendingInputListener,
	type PendingInputRead,
	PendingInputStore,
	type PendingInputStoreOptions,
	PendingInputStoreUnavailableError,
	type PendingInputTransaction,
	type StopItem,
	type StopReceipt,
} from "./pending-input-store.ts";
export type * from "./pending-input-types.ts";
