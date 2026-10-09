export const KERNEL_TOOL_ERROR_CODES = [
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
] as const;

export type KernelToolErrorCode = (typeof KERNEL_TOOL_ERROR_CODES)[number];

/** Why a nested host call was refused: it is outside the call's allow list, or named by its deny list. */
export type KernelToolHostDenialReason = "allow" | "deny";

/** Payload carried by `kernel_tool_host_denied`: the host tool, the invoking kernel-tool call, the reason. */
export type KernelToolHostDenial = {
	readonly tool: string;
	readonly call_id: string;
	readonly reason: KernelToolHostDenialReason;
};

export class KernelToolError extends Error {
	readonly name = "KernelToolError";
	readonly code: KernelToolErrorCode;
	/** Structured payload for the codes that carry one; only `kernel_tool_host_denied` does today. */
	readonly details?: KernelToolHostDenial;

	constructor(code: KernelToolErrorCode, message: string, details?: KernelToolHostDenial) {
		super(message);
		this.code = code;
		if (details !== undefined) this.details = details;
	}
}

export function kernelToolError(
	code: KernelToolErrorCode,
	message: string,
	details?: KernelToolHostDenial,
): KernelToolError {
	return new KernelToolError(code, message, details);
}
