import type { KernelToHostMessage } from "../../bridge/protocol.ts";

export type ResultMessage = Extract<KernelToHostMessage, { type: "result" }>;
export type ToolCallMessage = Extract<KernelToHostMessage, { type: "tool-call" }>;

export type JavaScriptKernelMode = "worker" | "inline";

export interface JavaScriptKernelOptions {
	readonly sessionId: string;
	readonly cwd: string;
	readonly parallelPoolWidth: number;
	readonly onMessage?: (message: KernelToHostMessage) => void;
	readonly workerEntryUrl?: URL;
}

export interface JavaScriptRunInput {
	readonly cellId: string;
	readonly code: string;
	readonly timeoutMs?: number;
	readonly onMessage?: (message: KernelToHostMessage) => void;
}

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
