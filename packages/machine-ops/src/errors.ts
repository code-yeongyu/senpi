import type { OpErrorCode } from "./types.ts";

/** An error raised by the operation layer itself; filesystem and spawn errors pass through unchanged. */
export class MachineOpError extends Error {
	readonly code: OpErrorCode;
	constructor(code: OpErrorCode, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "MachineOpError";
		this.code = code;
	}
}

const ERRNO_CODES: Readonly<Record<string, OpErrorCode>> = {
	ENOENT: "not_found",
	ENOTDIR: "not_found",
	EACCES: "permission_denied",
	EPERM: "permission_denied",
	ABORT_ERR: "aborted",
};

/** Classify any error an operation rejected with, so a wire answer can carry one code. */
export function opErrorCode(error: unknown): OpErrorCode {
	if (error instanceof MachineOpError) return error.code;
	if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
		return ERRNO_CODES[error.code] ?? "io_error";
	}
	return "io_error";
}
