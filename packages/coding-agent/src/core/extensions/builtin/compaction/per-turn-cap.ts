import type { CompactionExtensionState } from "./state.ts";

export function incrementAccepted(state: CompactionExtensionState): CompactionExtensionState {
	return {
		...state,
		acceptedThisTurn: state.acceptedThisTurn + 1,
		acceptedAbsolute: state.acceptedAbsolute + 1,
	};
}

export function incrementIneffective(state: CompactionExtensionState): CompactionExtensionState {
	return {
		...state,
		ineffectiveAttemptsThisTurn: state.ineffectiveAttemptsThisTurn + 1,
	};
}

/**
 * Successful compactions never consume an admission budget. The absolute
 * counter remains telemetry for long-lived sessions, while the circuit breaker
 * independently halts repeated failed or ineffective attempts.
 */
export function shouldRejectByCap(_state: CompactionExtensionState): { cancel: false } {
	return { cancel: false };
}
