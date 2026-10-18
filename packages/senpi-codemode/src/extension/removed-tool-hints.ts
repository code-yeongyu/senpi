/** Migration guidance for the tools eval replaced; the host returns it when a model calls them. */
export interface RemovedToolHintRegistrar {
	registerRemovedToolHint(name: string, hint: string): void;
}

export const WAIT_REMOVED_TOOL_HINT =
	"wait is not a tool; inside a cell use the wait(handles) helper (tool_schema('eval:wait')), or let detached cells notify.";

export function registerRemovedToolHints(pi: RemovedToolHintRegistrar): void {
	pi.registerRemovedToolHint(
		"exec",
		'exec was removed; use eval({ language: "js", code }) instead. Long eval cells detach on their own and notify when complete.',
	);
	pi.registerRemovedToolHint("wait", WAIT_REMOVED_TOOL_HINT);
}
