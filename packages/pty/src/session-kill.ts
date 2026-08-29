import { normalizeOperationResult, notStartedOperation } from "./session-exit.ts";
import type { TerminalSessionHandle, TerminalSessionOperationResult, TerminalSessionSignal } from "./session-types.ts";

export interface TerminalSessionKillOutcome {
	readonly result: TerminalSessionOperationResult;
	readonly signal: TerminalSessionSignal | null;
}

export function killTerminalSession(
	handle: TerminalSessionHandle | null,
	signal: TerminalSessionSignal,
	previousSignal: TerminalSessionSignal | null,
	exited: boolean,
): TerminalSessionKillOutcome {
	if (exited || (previousSignal !== null && (signal !== "SIGKILL" || previousSignal === "SIGKILL"))) {
		return {
			signal: previousSignal,
			result: {
				ok: true,
				idempotent: true,
				note: "Terminal session kill was already requested.",
			},
		};
	}
	if (handle === null) return { signal: previousSignal, result: notStartedOperation("kill") };
	const result = normalizeOperationResult(handle.kill(signal), `Sent ${signal} to terminal session.`);
	return { signal: result.ok ? signal : previousSignal, result };
}
