/**
 * The error a turn ends with when a required compaction could not bring the context back under the window.
 * It names no slash command, because print mode, RPC and SDK callers show it as is; the TUI swaps in its own wording.
 */
export const REQUIRED_COMPACTION_ERROR_MESSAGE =
	"Context remains above the compaction threshold because compaction did not complete. Retry the prompt to run compaction again, or start a new session.";

/** A required compaction did not complete; `code` lets SDK callers branch on it without matching the message. */
export class RequiredCompactionError extends Error {
	readonly code = "compaction_failed" as const;

	constructor() {
		super(REQUIRED_COMPACTION_ERROR_MESSAGE);
		this.name = "RequiredCompactionError";
	}
}
