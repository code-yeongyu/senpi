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

interface RetireFrame {
	readonly call: OutstandingCall;
	readonly completed: readonly OutstandingCall[];
	readonly everyChildCompleted: boolean;
	readonly calls: CallProjection[];
}

function frame(table: CompactCallTable, call: OutstandingCall): RetireFrame {
	const children = table.childrenOf(call.runtimeItemKey);
	const completed = children.filter(terminal);
	return { call, completed, everyChildCompleted: completed.length === children.length, calls: [] };
}

/**
 * Post-order over the completed descendants with an explicit stack (RULING-59 (1), RULING-67 (2)): one frame per open
 * level, so the stack is bounded by the live call table, never by the JS stack, and a chain of any depth settles. A
 * call leaves the table once every completed child has, in the order the recursive walk removed them.
 */
function retire(table: CompactCallTable, call: OutstandingCall): CallProjection {
	const stack = [frame(table, call)];
	for (;;) {
		const top = stack[stack.length - 1];
		if (!top) throw new Error("call retirement lost its root");
		const child = top.completed[top.calls.length];
		if (child) {
			stack.push(frame(table, child));
			continue;
		}
		table.remove(top.call.runtimeItemKey);
		const complete = top.everyChildCompleted && top.calls.every((projection) => projection.nestedCalls.complete);
		const projection: CallProjection = {
			...projectionOf(top.call),
			nestedCalls: { calls: top.calls, complete, omitted: 0 },
		};
		stack.pop();
		const parent = stack[stack.length - 1];
		if (!parent) return projection;
		parent.calls.push(projection);
	}
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
