import type { KernelToolError, KernelToolHostDenialReason } from "./kernel-tools-errors.ts";
import type { KernelToolsInvokeScope } from "./kernel-tools-types.ts";

export function hostToolRefusal(
	scope: KernelToolsInvokeScope | undefined,
	toolName: string,
): KernelToolHostDenialReason | null;

export function hostDeniedError(toolName: string, callId: string, reason: KernelToolHostDenialReason): KernelToolError;
