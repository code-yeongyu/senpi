import type { KernelToolsInvokeScope } from "./kernel-tools-types.ts";

export const kernelToolCallContext: {
	run<T>(store: KernelToolCallStore, fn: () => T): T;
	getStore(): KernelToolCallStore | undefined;
};

export type KernelToolCallStore = {
	readonly pendingTools: Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
	readonly callId: string;
	readonly generation: number;
	readonly signal: AbortSignal;
	/** Host tools this call's nested bridge calls may reach; absent means the parent's full surface. */
	readonly scope?: KernelToolsInvokeScope;
};

export function inKernelToolInvoke(): boolean;
