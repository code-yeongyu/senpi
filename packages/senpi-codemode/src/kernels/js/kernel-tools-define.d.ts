export type KernelToolFunction = {
	readonly name: string;
};

export type KernelToolNamespaceRegistry = {
	readonly defined?: () => string[];
	readonly undefine?: (name: unknown) => boolean;
};

export function createToolNamespace(
	define: (fn: KernelToolFunction, metadata?: unknown) => unknown,
	callHost: (name: string, args: unknown) => Promise<unknown>,
	registry?: KernelToolNamespaceRegistry,
): ((fn: KernelToolFunction, metadata?: unknown) => unknown) & {
	readonly [name: string]: (args?: unknown) => Promise<unknown>;
};
