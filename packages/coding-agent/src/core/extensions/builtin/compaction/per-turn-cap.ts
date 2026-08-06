import type { CompactionExtensionState } from "./state.ts";

export const hardCap = 10;

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

export function isOverHardCap(state: CompactionExtensionState): boolean {
	return state.acceptedAbsolute >= hardCap;
}

/**
 * Admission is bounded only by the absolute session cap. The former per-turn
 * soft cap (3 accepted + ineffective attempts) rejected required compactions
 * mid-turn, which fatally ended turns that legitimately needed more than three
 * compactions. Runaway protection remains: `hardCap` bounds accepted
 * compactions per session and the circuit breaker halts repeated failures.
 */
export function shouldRejectByCap(state: CompactionExtensionState): { cancel: boolean } {
	return { cancel: isOverHardCap(state) };
}
