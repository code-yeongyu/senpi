import type { EvalSchemaToolInfo } from "../bridges/schema-bridge.ts";

export interface ReachableToolRegistry {
	getActiveTools(): string[];
	getAllTools(): readonly EvalSchemaToolInfo[];
}

/**
 * The tools a cell can call: the model-visible active tools plus every registered tool whose declared
 * exposure is `eval`. The session withholds an eval-exposed tool from the model whenever eval itself is
 * registered (bash, grep, glob, generate_image, a plugin's thread_* or task_* family), so it is absent
 * from `getActiveTools()` while `executeTool` still reaches it; reading only the active list made
 * `agent()`/`output()` report the task tool unavailable and dropped its kernel prelude the moment it
 * became eval-only (senpi#6269 follow-up).
 */
export function reachableToolNames(pi: ReachableToolRegistry): Set<string> {
	const names = new Set(pi.getActiveTools());
	for (const tool of registeredTools(pi)) if (tool.exposure === "eval") names.add(tool.name);
	return names;
}

// The loader's registry methods throw until the runtime binds (the dedupe probe in
// coding-agent's codemode-builtin-dedupe.test.ts registers eval before that point); an
// unreadable registry adds nothing, like promptKernelPreludes.
function registeredTools(pi: ReachableToolRegistry): readonly EvalSchemaToolInfo[] {
	try {
		return pi.getAllTools();
	} catch {
		return [];
	}
}
