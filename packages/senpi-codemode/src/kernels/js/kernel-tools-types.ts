import type { ExtensionKernelTools, KernelToolInvokeOptions, KernelToolInvokeScope } from "@code-yeongyu/senpi";
import type { EvalLanguage } from "../../tool/types.ts";
import type { KernelToolErrorCode, KernelToolHostDenial, KernelToolHostDenialReason } from "./kernel-tools-errors.ts";

export type { KernelToolErrorCode, KernelToolHostDenial, KernelToolHostDenialReason };

export type KernelToolDescriptor = {
	readonly name: string;
	readonly description: string;
	readonly input_schema: unknown;
	readonly language: EvalLanguage;
	readonly kernel_generation: number;
	readonly definition_revision: number;
};

export type KernelToolsInvokeRequest = {
	readonly name: string;
	readonly kernel_generation: number;
	readonly definition_revision: number;
	readonly args: unknown;
	readonly call_id: string;
};

export type KernelToolsDescribeEntry =
	| { readonly name: string; readonly ok: true; readonly descriptor: KernelToolDescriptor }
	| {
			readonly name: string;
			readonly ok: false;
			readonly error: { readonly code: KernelToolErrorCode; readonly message: string };
	  };

export type KernelToolsDescribeResult = {
	readonly results: readonly KernelToolsDescribeEntry[];
};

/** Host declaration (#1731); aliases so this package cannot drift from `@code-yeongyu/senpi`. */
export type KernelToolsHostScope = NonNullable<KernelToolInvokeScope["tools"]>;
export type KernelToolsInvokeScope = KernelToolInvokeScope;
export type KernelToolsInvokeOptions = KernelToolInvokeOptions;

/** Stable capability markers a consumer gates on before sending an option this runtime may not know. */
export type KernelToolsCapabilities = ExtensionKernelTools["capabilities"];

export const KERNEL_TOOLS_CAPABILITIES = Object.freeze({
	invokeScope: true as const,
}) satisfies ExtensionKernelTools["capabilities"];

export type KernelToolsCapability = {
	readonly capabilities: ExtensionKernelTools["capabilities"];
	describe(names: readonly string[]): Promise<KernelToolsDescribeResult>;
	invoke: ExtensionKernelTools["invoke"];
};

export const KERNEL_TOOLS_UNSUPPORTED = {
	code: "tools_unavailable" as const,
	message: "Kernel tools require a live JavaScript worker context",
};
