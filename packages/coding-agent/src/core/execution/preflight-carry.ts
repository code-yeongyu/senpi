import { transferDispatchApproval } from "../extensions/builtin/permission-system/dispatch.ts";
import { transferApprovedMonitorParent } from "../extensions/builtin/terminal/monitor-permission.ts";

/**
 * The session's `afterToolFreeze`: the session's `tool_call` chain binds facts to the arguments object it saw, and the
 * prepared executor runs a frozen copy, so each fact moves to that copy here (senpi#5795). Both transfers are no-ops for
 * anything that is not an object and never throw.
 */
export function carryPreflightFacts(prepared: unknown, frozen: unknown): void {
	transferDispatchApproval(prepared, frozen);
	transferApprovedMonitorParent(prepared, frozen);
}
