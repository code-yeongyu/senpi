import type { KernelMemoryThresholds } from "../../bridge/memory-protocol.ts";
import type { KernelToHostMessage } from "../../bridge/protocol.ts";
import type { EvalKernelRunInput } from "../../tool/types.ts";
import type { SessionEnvironment } from "../session-env.ts";
import type { JavaScriptInterruptBounds } from "./interrupt-bounds.ts";

export type ResultMessage = Extract<KernelToHostMessage, { type: "result" }>;
export type ToolCallMessage = Extract<KernelToHostMessage, { type: "tool-call" }>;

export type JavaScriptKernelMode = "worker" | "inline" | "process";

/** Snapshot or live provider consulted when the worker registry checks collisions. */
export type KernelToolNameSource = readonly string[] | (() => readonly string[]);

export function resolveKernelToolNameSource(names?: KernelToolNameSource): string[] {
	if (typeof names === "function") return [...names()];
	return names === undefined ? [] : [...names];
}

export interface JavaScriptKernelOptions {
	readonly sessionId: string;
	readonly cwd: string;
	/**
	 * Collects the exit status of a retired worker's children once they are killed (#1962): no thread is left to
	 * wait on them. Absent, they stay zombies until the host's child reaper or process exit collects them.
	 */
	readonly collectOrphanedChildren?: (pids: readonly number[]) => Promise<unknown>;
	readonly parallelPoolWidth: number;
	readonly onMessage?: (message: KernelToHostMessage) => void;
	readonly workerEntryUrl?: URL;
	/** Per-session PI_* values applied to the worker environment before the first cell runs. */
	readonly sessionEnv?: SessionEnvironment;
	/** Opt-in child-process kernel; absent keeps the worker-thread kernel. */
	readonly isolation?: "process";
	/** Resolution root for the process-mode runtime (bun, then node); `""` names a machine with none on PATH. */
	readonly processCommandPath?: string;
	/** The host's executable, which runs the child when it is bun or node; defaults to `process.execPath`. */
	readonly processExecPath?: string;
	/** How long a process-mode child gets to report ready; defaults to `PROCESS_STARTUP_DEADLINE_MS`. */
	readonly processStartupDeadlineMs?: number;
	/** Process-mode memory policy: the host reads the child's footprint instead of the in-heap worker reading. */
	readonly processMemory?: {
		readonly thresholds: KernelMemoryThresholds;
		readonly readFootprint?: (pid: number) => { readonly bytes: number } | undefined;
	};
	/** Host tool names denied as JS kernel-tool identifiers (init protocol). */
	readonly hostToolNames?: KernelToolNameSource;
	/** `kernelTools.enabled`; false makes `tool(fn)` refuse with `tools_unavailable`. Unset keeps them on. */
	readonly kernelToolsEnabled?: boolean;
	/** Tool names registered in another kernel language, denied as JS kernel-tool identifiers. */
	readonly foreignLanguageNames?: KernelToolNameSource;
	/** Post-cell collection, notice, and ceiling thresholds; absent leaves the worker's memory unmanaged. */
	readonly memory?: KernelMemoryThresholds;
	/** Live heap bytes measured by an idle collection the worker ran between cells. */
	readonly onMemoryCollected?: (liveBytes: number) => void;
	/** Interrupt acknowledgement, settle grace, and worker-termination deadlines; absent uses `DEFAULT_INTERRUPT_BOUNDS`. */
	readonly interruptBounds?: JavaScriptInterruptBounds;
}

export type JavaScriptRunInput = EvalKernelRunInput;

export type KernelOperation = "run" | "reset" | "interrupt";
export type LifecycleState = "open" | "closing" | "closed";

export class JavaScriptKernelClosedError extends Error {
	readonly name = "JavaScriptKernelClosedError";
	readonly operation: KernelOperation;

	constructor(operation: KernelOperation) {
		super(`Cannot ${operation}: JavaScript kernel is closed`);
		this.operation = operation;
	}
}

export function assertJavaScriptKernelOpen(lifecycle: LifecycleState, operation: KernelOperation): void {
	if (lifecycle !== "open") throw new JavaScriptKernelClosedError(operation);
}
