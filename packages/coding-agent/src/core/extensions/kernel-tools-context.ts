import { AsyncLocalStorage } from "node:async_hooks";

/** Host tools a kernel-tool invocation's nested calls may reach. `deny` wins when both name the same tool. */
export type KernelToolInvokeScope = {
	tools?: {
		allow?: string[];
		deny?: string[];
	};
};

export type KernelToolInvokeOptions = {
	signal?: AbortSignal;
	scope?: KernelToolInvokeScope;
};

export type ExtensionKernelTools = {
	readonly capabilities: {
		readonly invokeScope: boolean;
	};
	describe(names: readonly string[]): Promise<unknown>;
	invoke(
		request: {
			name: string;
			kernel_generation: number;
			definition_revision: number;
			args: unknown;
			call_id: string;
		},
		options?: AbortSignal | KernelToolInvokeOptions,
	): Promise<unknown>;
};

export const kernelToolsStorage = new AsyncLocalStorage<ExtensionKernelTools>();
