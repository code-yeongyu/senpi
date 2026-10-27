import type { FileEntry } from "./session-manager.ts";
import type { SessionRecoveryCause } from "./session-write-recovery.ts";

/** A header writer owns its queue even when compaction replaces the resident mirror. */
export interface HeaderWriteState {
	readonly kind: "writing";
	readonly file: string;
	readonly entries: FileEntry[];
}

/**
 * Buffering cannot retain a previous file's append cursor, ownership, or torn-tail cause. The one tail it carries is
 * the opened file's own: a torn final line whose backup the disk refused (`deferredTail`), set aside before the
 * first append once the load completes.
 */
export type SessionWriteState =
	| { readonly kind: "buffered"; readonly deferredTail?: SessionRecoveryCause }
	| HeaderWriteState
	| {
			readonly kind: "flushed";
			readonly ownedHeaderFile?: string;
			pending?: { readonly entries: FileEntry[]; from: number };
			tailFailure?: { readonly cause: SessionRecoveryCause; readonly completeBytes?: number };
	  };
