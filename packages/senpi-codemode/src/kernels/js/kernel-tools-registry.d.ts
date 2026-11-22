export { createToolNamespace } from "./kernel-tools-define.js";

export type KernelToolRegistryOptions = {
	readonly generation?: number;
	readonly language?: "js" | "py" | "rb" | "jl";
	readonly hostToolNames?: readonly string[] | (() => readonly string[]);
	readonly foreignLanguageNames?: readonly string[] | (() => readonly string[]);
	readonly reservedNames?: readonly string[];
};

export function createKernelToolRegistry(options?: KernelToolRegistryOptions): {
	readonly generation: number;
	define(fn: { readonly name: string }, metadata?: unknown): unknown;
	describe(names: readonly string[]): unknown;
	invoke(
		request: {
			readonly name: string;
			readonly kernel_generation: number;
			readonly definition_revision: number;
			readonly args: unknown;
			readonly call_id: string;
		},
		signal?: AbortSignal,
	): Promise<unknown>;
	defined(): string[];
	undefine(name: unknown): boolean;
	bumpGeneration(): number;
	setCollisionNames(hostToolNames?: readonly string[], foreignLanguageNames?: readonly string[]): void;
};
