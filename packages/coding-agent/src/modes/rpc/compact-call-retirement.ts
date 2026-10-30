import {
	type CallProjection,
	NESTED_PROJECTION_LIMIT,
	type OutstandingCall,
	TERMINAL_PHASE,
	terminal,
} from "./compact-call-model.ts";
import type { CompactCallTable } from "./compact-call-table.ts";

/** The reader fields a retired call leaves behind: everything but its phase, join and owned slots (RULING-13 Q2). */
function projectionOf(call: OutstandingCall): Omit<CallProjection, "nestedCalls"> {
	const { phase: _phase, join: _join, raw: _raw, hook: _hook, progress: _progress, result: _result, ...fields } = call;
	return fields;
}

/**
 * The carrier settled: the call and its completed descendants leave the table with one projection. Completed children
 * beyond `NESTED_PROJECTION_LIMIT` (the parent's own nested-call record bound, RULING-13 Q5) are counted in `omitted`
 * (RULING-49); they, a child still executing or an incomplete child mark the projection incomplete.
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
	const nested = completed.map((child) => retire(table, child));
	const calls = nested.slice(0, NESTED_PROJECTION_LIMIT);
	const omitted = nested.length - calls.length;
	table.remove(call.runtimeItemKey);
	return {
		...projectionOf(call),
		nestedCalls: {
			calls,
			complete:
				omitted === 0 && completed.length === children.length && calls.every((child) => child.nestedCalls.complete),
			omitted,
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
