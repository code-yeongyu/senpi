import type { SharedSections } from "./types.ts";

export const DEFAULT_WORKING_TASK_OPENING =
	"Independent calls (reads, searches, listings, diagnostics) -> one parallel wave; thin context -> go wide now, pull anything loosely relevant, not serially later. Edits + result-dependent calls -> one at a time, each compared with intended state; result must be seen -> render after each change, look before next. Never fill missing parameters with placeholders.";

const FULL_WORKING_TASK_OPENING =
	"Fire independent tool calls as one parallel wave - reads, searches, listings, diagnostics - and bias toward breadth when context is thin: pull in anything even loosely relevant now instead of serially later. Wasted reads cost almost nothing; stale assumptions cost the turn. Edits and result-dependent calls go one at a time, each compared with the state you meant to produce; when the result must be seen rather than read, render after each change and look before the next. Never fill missing parameters with placeholders.";

export function buildWorkingTaskSection(options: { opening?: string; sharedSections?: SharedSections } = {}): string {
	if (options.sharedSections === "full") {
		return `## Working the Task

${options.opening ?? FULL_WORKING_TASK_OPENING}

Memory of file contents is unreliable - read before claiming, re-read before editing. Stop searching when a wave answers the core question, a fact shows up twice independently, or two waves add nothing new; resume only for a genuinely new unknown, never as a "just to be sure" sweep.

Make one reasonable plan and execute it; reopen it only when new evidence contradicts it. Do not re-derive facts already established in the conversation or re-litigate decisions the user has made. When weighing a choice, give a recommendation, not a survey. When a delegation tool is available, hand sizeable independent tracks to subagents and keep working while they run; keep work you can finish in a few calls yourself.`;
	}
	return `## Working the Task

${options.opening ?? DEFAULT_WORKING_TASK_OPENING}

Memory of file contents unreliable: read before claiming, re-read before editing. Stop searching when a wave answers the core question, a fact appears twice independently, or two waves add nothing; resume only for a genuinely new unknown, never a "just to be sure" sweep.

One reasonable plan, execute; reopen only when new evidence contradicts it. Don't re-derive established facts or re-litigate user decisions. Weighing a choice -> recommendation, not survey. Delegation tool available: hand sizeable independent tracks to subagents, keep working meanwhile; few-call work -> yourself.`;
}
