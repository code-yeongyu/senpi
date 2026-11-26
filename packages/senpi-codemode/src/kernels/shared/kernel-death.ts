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

/** Globals a lost kernel held, as its last result reported them: their names and how many there were in all. */
export interface LostGlobals {
	readonly names: readonly string[];
	readonly count: number;
}

const NAMED_LOST_GLOBALS = 20;

export function restartNotice(language: EvalLanguage, reason: string, lost?: LostGlobals): string {
	return `[${language} kernel was restarted after ${reason}; every global is lost${lostPhrase(lost)}]`;
}

/** The first result of a session's kernel when an earlier kernel of the same session ended with globals defined. */
export function replacedKernelNotice(language: EvalLanguage, lost: LostGlobals): string {
	return `[${language} kernel is new: this session's previous ${language} kernel ended (session reload, host restart, or resume), so every global it held is gone${lostPhrase(lost)}]`;
}

function lostPhrase(lost: LostGlobals | undefined): string {
	if (lost === undefined || lost.count === 0) return "";
	const named = lost.names.slice(0, NAMED_LOST_GLOBALS);
	const more = lost.count - named.length;
	return `. Lost: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
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
