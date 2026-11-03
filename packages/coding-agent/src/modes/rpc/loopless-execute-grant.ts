/**
 * Who may run tool calls on a loopless runtime (senpi#5413). Until the remote tool executor runs the extensions'
 * `tool_call`/`tool_result` handlers (permission checks among them) for a tool-execution-only process, nothing in the
 * product may execute through a loopless runtime: the only allowed caller is the in-process test harness. Closed and
 * fail-closed: a runtime built without a grant this module issued refuses every call.
 */
const LOOPLESS_EXECUTE_CALLERS = ["in-process-test-harness"] as const;

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

/** True only for a grant this module issued to an allowed caller. */
export function isLooplessExecuteGranted(grant: LooplessExecuteGrant | undefined): boolean {
	return grant !== undefined && issued.has(grant) && LOOPLESS_EXECUTE_CALLERS.includes(grant.caller);
}
