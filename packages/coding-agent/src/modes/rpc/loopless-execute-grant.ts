/**
 * Who may run tool calls on a loopless runtime (senpi#5413). Closed and fail-closed: a runtime built without a grant this
 * module issued refuses every call. Two callers exist:
 * - the in-process test harness, which runs tools directly;
 * - the remote tool executor (S27a). A runtime built with its grant runs the extensions' `tool_call` handlers
 *   (permission checks among them) before every call and the `tool_result` handlers after it; a `tool_call` handler
 *   that blocks or throws stops the call before the tool runs.
 */
const LOOPLESS_EXECUTE_CALLERS = ["in-process-test-harness", "remote-tool-executor"] as const;

export type LooplessExecuteCaller = (typeof LOOPLESS_EXECUTE_CALLERS)[number];

export interface LooplessExecuteGrant {
	readonly caller: LooplessExecuteCaller;
}

const issued = new WeakSet<LooplessExecuteGrant>();

export class LooplessExecuteRefusedError extends Error {
	constructor(reason: string) {
		super(`loopless_execute_refused: ${reason}`);
	}
}

/** Issues the test harness's grant; anywhere but a Vitest run it refuses. */
export function grantLooplessExecuteToTestHarness(): LooplessExecuteGrant {
	if (process.env.VITEST !== "true")
		throw new LooplessExecuteRefusedError("only the in-process test harness may execute");
	const grant: LooplessExecuteGrant = Object.freeze({ caller: "in-process-test-harness" });
	issued.add(grant);
	return grant;
}

/** Issues the remote tool executor's grant: every call made with it runs the extensions' tool handlers. */
export function grantLooplessExecuteToRemoteExecutor(): LooplessExecuteGrant {
	const grant: LooplessExecuteGrant = Object.freeze({ caller: "remote-tool-executor" });
	issued.add(grant);
	return grant;
}

/** True when calls made with `grant` must run the extensions' `tool_call`/`tool_result` handlers. */
export function looplessGrantRunsToolHandlers(grant: LooplessExecuteGrant | undefined): boolean {
	return isLooplessExecuteGranted(grant) && grant?.caller === "remote-tool-executor";
}

/** True only for a grant this module issued to an allowed caller. */
export function isLooplessExecuteGranted(grant: LooplessExecuteGrant | undefined): boolean {
	return grant !== undefined && issued.has(grant) && LOOPLESS_EXECUTE_CALLERS.includes(grant.caller);
}
