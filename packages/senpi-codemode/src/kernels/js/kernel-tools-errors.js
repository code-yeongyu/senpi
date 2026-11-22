export const KERNEL_TOOL_ERROR_CODES = Object.freeze([
	"tools_unavailable",
	"invalid_tool_definition",
	"reserved_tool_name",
	"tool_name_collision",
	"kernel_tool_stale",
	"kernel_tool_missing",
	"kernel_tool_failed",
	"kernel_tool_recursion",
	"kernel_tool_host_denied",
	"kernel_tool_cancelled",
	"kernel_tool_loop_mismatch",
]);

export class KernelToolError extends Error {
	constructor(code, message, details) {
		super(message);
		this.name = "KernelToolError";
		this.code = code;
		// Only `kernel_tool_host_denied` carries one today: { tool, call_id, reason }.
		if (details !== undefined) this.details = details;
	}
}

export function kernelToolError(code, message, details) {
	return new KernelToolError(code, message, details);
}
