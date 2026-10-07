import type {
	KernelToolsDescribeResult,
	KernelToolsInvokeOptions,
	KernelToolsInvokeRequest,
} from "../kernels/js/kernel-tools-types.ts";
import type { EvalKernel } from "../tool/types.ts";

/** The kernel-tools surface a JavaScript kernel exposes; `run-eval-cell` finds it by probing for these methods. */
export interface KernelToolsMethods {
	describeKernelTools(names: readonly string[]): Promise<KernelToolsDescribeResult>;
	invokeKernelTool(
		request: KernelToolsInvokeRequest,
		options?: AbortSignal | KernelToolsInvokeOptions,
	): Promise<unknown>;
}

export function hasKernelTools(kernel: EvalKernel): kernel is EvalKernel & KernelToolsMethods {
	return (
		"describeKernelTools" in kernel &&
		typeof kernel.describeKernelTools === "function" &&
		"invokeKernelTool" in kernel &&
		typeof kernel.invokeKernelTool === "function"
	);
}
