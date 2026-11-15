import type { Limits, MachineOps, OpContext, OpName, PolicyHooks } from "@code-yeongyu/senpi-machine-ops";

/**
 * The hooks the tool path honours: only `beforeOp`, once per tool call. The tools run the extension filesystem policy
 * themselves and sub-operations carry no hooks, so `filesystem` and `afterOp` are rejected at compile time instead of
 * being silently ignored.
 */
export type ToolPathPolicy = Pick<PolicyHooks, "beforeOp"> & {
	readonly filesystem?: never;
	readonly afterOp?: never;
};

/** One MachineOps bound to the tool path: principal `local-session`, no scope root (the tools resolve paths). */
export interface ToolMachine {
	readonly ops: MachineOps;
	/**
	 * Runs `PolicyHooks.beforeOp` once for one tool call; a denial rejects with `Error(reason)` before any effect.
	 * Without a `beforeOp` it returns undefined synchronously, so a tool that awaits only a returned promise keeps
	 * its exact pre-layer timing (bash emits its first partial update before any await).
	 */
	begin(op: OpName, args: unknown, signal: AbortSignal | undefined): Promise<void> | undefined;
	/** Context for a sub-operation inside a call `begin` already admitted. */
	context(signal: AbortSignal | undefined, pathLock?: "caller"): OpContext;
}

/**
 * Tool-path limits over the machine's own defaults. The tools keep their own truncation (truncate.ts, the output
 * accumulator), so the operation layer reads files whole and streams exec output uncaptured.
 */
function toolPathLimits(machineLimits: Limits): Limits {
	return {
		...machineLimits,
		readMaxBytes: Number.POSITIVE_INFINITY,
		execStdoutMaxBytes: 0,
		execStderrMaxBytes: 0,
		execTimeoutDefaultMs: Number.POSITIVE_INFINITY,
	};
}

const NEVER_ABORTED = new AbortController().signal;

/** Binds the tool path to the MachineOps `resolveOps` returns, read on every use. */
export function bindToolMachine(resolveOps: () => MachineOps, policy?: ToolPathPolicy): ToolMachine {
	const context = (signal: AbortSignal | undefined, pathLock?: "caller"): OpContext => ({
		scope: { id: "local-session" },
		principal: { kind: "local-session", id: "local-session" },
		signal: signal ?? NEVER_ABORTED,
		limits: toolPathLimits(resolveOps().limits),
		// The tools run the extension filesystem policy themselves (with their own error text) and the gate below
		// already ran once for the call, so sub-operations carry no hooks.
		policy: {},
		...(pathLock !== undefined ? { pathLock } : {}),
	});
	return {
		get ops() {
			return resolveOps();
		},
		begin(op, args, signal) {
			const beforeOp = policy?.beforeOp;
			if (beforeOp === undefined) return undefined;
			return beforeOp(op, args, { ...context(signal), policy: policy ?? {} }).then((decision) => {
				if (!decision.allow) throw new Error(decision.reason);
			});
		},
		context,
	};
}

/** A ToolMachine over a host-supplied MachineOps (a remote device, a sandbox): the tools' only effect channel. */
export function createToolMachine(options: { ops: MachineOps; policy?: ToolPathPolicy }): ToolMachine {
	return bindToolMachine(() => options.ops, options.policy);
}
