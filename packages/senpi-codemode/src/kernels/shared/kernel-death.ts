import { constants } from "node:os";
import type { EvalKernelResult, EvalLanguage } from "../../tool/types.ts";

/** How the session manager hears that a kernel's interpreter died. */
export interface KernelLifecycle {
	/** Called once when the interpreter died on its own; the kernel then keeps its unstarted cells for `drainPending`. */
	readonly onDeath?: (reason: string) => void;
}

/** The wording a restart notice uses for an exit nobody asked for: "signal 9", "exit code 1". */
export function describeExit(code: number | null, signal: string | null): string {
	if (signal !== null) {
		const number = Object.entries(constants.signals).find(([name]) => name === signal)?.[1];
		return `signal ${number ?? signal}`;
	}
	return code === null ? "an exit with no status" : `exit code ${code}`;
}

export function restartNotice(language: EvalLanguage, reason: string): string {
	return `[${language} kernel was restarted after ${reason}; every global is lost]`;
}

export const EVAL_KERNEL_UNAVAILABLE = "eval_kernel_unavailable";

/** A queued cell that never ran: its kernel died again before the replacement finished one cell. */
export class KernelUnavailableError extends Error {
	readonly name = "KernelUnavailableError";
	readonly code = EVAL_KERNEL_UNAVAILABLE;

	constructor(language: EvalLanguage, reason: string) {
		super(
			`${EVAL_KERNEL_UNAVAILABLE}: the ${language} kernel died again (${reason}) before its replacement finished a cell; this cell never ran. Run it again to start a fresh kernel.`,
		);
	}
}

export function unstartedResult(cellId: string, message: string): EvalKernelResult {
	return { type: "result", cellId, ok: false, error: { message }, durationMs: 0, kernelState: "not-run" };
}
