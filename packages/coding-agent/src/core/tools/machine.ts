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
import { getAgentDir } from "../../config.ts";
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
 * The process-wide local MachineOps the built-in tools use when no caller supplies one. Created on first use: its
 * state (exec scope tokens) lives under `<agentDir>/machine/`.
 */
export function defaultLocalMachineOps(): MachineOps {
	processMachineOps ??= createLocalMachineOps({
		stateDir: getAgentDir(),
		holder: createInProcessHolderLink(),
		killProcessTree,
		resolveFd: () => ensureTool("fd"),
	});
	return processMachineOps;
}

/** One MachineOps bound to the tool path: principal `local-session`, no scope root (the tools resolve paths). */
export interface ToolMachine {
	readonly ops: MachineOps;
	/**
	 * Runs `PolicyHooks.beforeOp` once for one tool call and returns the context its sub-operations use (which carries
	 * no second gate). A denial throws `Error(reason)` before any effect.
	 */
	begin(op: OpName, args: unknown, signal: AbortSignal | undefined): Promise<OpContext>;
	/** Context for a sub-operation inside a call `begin` already admitted. */
	context(signal: AbortSignal | undefined, pathLock?: "caller"): OpContext;
}

const NEVER_ABORTED = new AbortController().signal;

export function createToolMachine(options?: { ops?: MachineOps; policy?: PolicyHooks }): ToolMachine {
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
		async begin(op, args, signal) {
			const beforeOp = options?.policy?.beforeOp;
			const ctx = context(signal);
			if (beforeOp !== undefined) {
				const decision = await beforeOp(op, args, { ...ctx, policy: options?.policy ?? {} });
				if (!decision.allow) throw new Error(decision.reason);
			}
			return ctx;
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
