import { type CallProjection, type OutstandingCall, TERMINAL_PHASE, terminal } from "./compact-call-model.ts";
import type { CompactCallTable } from "./compact-call-table.ts";

/** The reader fields a retired call leaves behind: everything but its phase, join and owned slots (RULING-13 Q2). */
function projectionOf(call: OutstandingCall): Omit<CallProjection, "nestedCalls"> {
	const { phase: _phase, join: _join, raw: _raw, hook: _hook, progress: _progress, result: _result, ...fields } = call;
	return fields;
}

/**
 * The carrier settled: the call and its completed descendants leave the table with one projection carrying every
 * completed child (RULING-60 Q3: the settled store pages it, nothing truncates it, so `omitted` is 0 on this path);
 * a child still executing or an incomplete child marks the projection incomplete.
 */
export function settleCall(table: CompactCallTable, call: OutstandingCall, isError: boolean): CallProjection {
	const settled: OutstandingCall = terminal(call)
		? call
		: { ...call, phase: TERMINAL_PHASE, outcome: { kind: "result", isError, source: "result_message" } };
	return retire(table, settled);
}

function retire(table: CompactCallTable, call: OutstandingCall): CallProjection {
	const children = table.childrenOf(call.runtimeItemKey);
	const completed = children.filter(terminal);
	const calls = completed.map((child) => retire(table, child));
	table.remove(call.runtimeItemKey);
	return {
		...projectionOf(call),
		nestedCalls: {
			calls,
			complete: completed.length === children.length && calls.every((child) => child.nestedCalls.complete),
			omitted: 0,
		},
	};
}

/** A child whose parent left the table, or can no longer get a carrier, has no projection to ride on. */
export function orphaned(table: CompactCallTable, call: OutstandingCall): boolean {
	if (call.parentKey === null) return false;
	const parent = table.get(call.parentKey);
	return parent === undefined || parent.join === "carrierless";
}

export const NOT_EXECUTED: Partial<OutstandingCall> = {
	phase: TERMINAL_PHASE,
	outcome: { kind: "not-executed" },
	join: "carrierless",
};

/** RULING-13 Q3/Q4: the sweep patch for one call, nested or not, once no carrier can arrive; `undefined` leaves it alone. */
export function settledPatch(call: OutstandingCall): Partial<OutstandingCall> | undefined {
	if (call.startSequence === null && !terminal(call)) return NOT_EXECUTED;
	if (call.phase === "executing")
		return { phase: TERMINAL_PHASE, outcome: { kind: "abandoned" }, join: "carrierless" };
	return call.join === "pending" ? { join: "carrierless" } : undefined;
}
