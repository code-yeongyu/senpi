export const DEFAULT_WORKING_TASK_OPENING =
	"Independent calls (reads, searches, listings, diagnostics) -> one parallel wave; thin context -> go wide now, pull anything loosely relevant, not serially later. Edits + result-dependent calls -> one at a time, each compared with intended state; result must be seen -> render after each change, look before next. Never fill missing parameters with placeholders.";

export function buildWorkingTaskSection(options: { opening?: string } = {}): string {
	return `## Working the Task

${options.opening ?? DEFAULT_WORKING_TASK_OPENING}

Memory of file contents unreliable: read before claiming, re-read before editing. Stop searching when a wave answers the core question, a fact appears twice independently, or two waves add nothing; resume only for a genuinely new unknown, never a "just to be sure" sweep.

One reasonable plan, execute; reopen only when new evidence contradicts it. Don't re-derive established facts or re-litigate user decisions. Weighing a choice -> recommendation, not survey. Delegation tool available: hand sizeable independent tracks to subagents, keep working meanwhile; few-call work -> yourself.`;
}
