import { REQUIRED_COMPACTION_ERROR_MESSAGE } from "../../core/required-compaction-error.ts";

export const REQUIRED_COMPACTION_INTERACTIVE_MESSAGE =
	"Context remains above the compaction threshold because compaction did not complete. Run /compact to retry, or /new to start a fresh session.";

/** The TUI has `/compact` and `/new`, so its failed-compaction error names them instead of the neutral recovery. */
export function interactiveErrorText(errorMessage: string): string {
	return errorMessage === REQUIRED_COMPACTION_ERROR_MESSAGE ? REQUIRED_COMPACTION_INTERACTIVE_MESSAGE : errorMessage;
}
