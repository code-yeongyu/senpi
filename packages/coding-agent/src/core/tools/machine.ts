import {
	createLocalMachineOps,
	DEFAULT_LIMITS,
	type Limits,
	type MachineOps,
	type OpContext,
	type OpName,
	type PolicyHooks,
} from "@code-yeongyu/senpi-machine-ops";
import { createInProcessHolderLink } from "@code-yeongyu/senpi-machine-ops/in-process-holder";
import { killProcessTree } from "../../utils/shell.ts";
import { ensureTool } from "../../utils/tools-manager.ts";

/**
 * Tool-path limits. The tools keep their own truncation (truncate.ts, the output accumulator), so the operation
 * layer reads files whole and streams exec output uncaptured, exactly as the tools did before the layer existed.
 */
const TOOL_PATH_LIMITS: Limits = {
	...DEFAULT_LIMITS,
	readMaxBytes: Number.POSITIVE_INFINITY,
	execStdoutMaxBytes: 0,
	execStderrMaxBytes: 0,
	execTimeoutDefaultMs: Number.POSITIVE_INFINITY,
};

let processMachineOps: MachineOps | undefined;

/**
 * The process-wide local MachineOps the built-in tools use when no caller supplies one. It has no `stateDir`, so it
 * records no scope tokens and writes nothing to disk: abort and timeout still kill the command's process group.
 */
function defaultLocalMachineOps(): MachineOps {
	processMachineOps ??= createLocalMachineOps({
		holder: createInProcessHolderLink(),
		// A call, not the bare reference: the session-path audit (no-sync-in-session-path) follows calls only, and the
		// Windows kill path behind it (`taskkill` via spawnSync) must stay visible to its ledger.
		killProcessTree: (pid) => killProcessTree(pid),
		resolveFd: () => ensureTool("fd"),
	});
	return processMachineOps;
}

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

const NEVER_ABORTED = new AbortController().signal;

export function createToolMachine(options?: { ops?: MachineOps; policy?: ToolPathPolicy }): ToolMachine {
	const resolveOps = () => options?.ops ?? defaultLocalMachineOps();
	const context = (signal: AbortSignal | undefined, pathLock?: "caller"): OpContext => ({
		scope: { id: "local-session" },
		principal: { kind: "local-session", id: "local-session" },
		signal: signal ?? NEVER_ABORTED,
		limits: TOOL_PATH_LIMITS,
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
			const policy = options?.policy;
			const beforeOp = policy?.beforeOp;
			if (beforeOp === undefined) return undefined;
			return beforeOp(op, args, { ...context(signal), policy: policy ?? {} }).then((decision) => {
				if (!decision.allow) throw new Error(decision.reason);
			});
		},
		context,
	};
}

let defaultMachine: ToolMachine | undefined;

/** The ToolMachine a tool factory uses when its options carry none. */
export function defaultToolMachine(): ToolMachine {
	defaultMachine ??= createToolMachine();
	return defaultMachine;
}

/** Bytes from the operation layer as the Buffer the tool seams have always returned. */
export function asBuffer(bytes: Uint8Array): Buffer {
	return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
