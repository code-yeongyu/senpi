import { kernelToolError } from "./js/kernel-tools-errors.ts";

export function rejectKernelToolsUnavailable(): Promise<never> {
	return Promise.reject(kernelToolError("tools_unavailable", "Kernel tools are JavaScript-only"));
}
