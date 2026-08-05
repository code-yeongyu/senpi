import type { CompactionReason } from "../../types.ts";
import type { CompactionExtensionState } from "./state.ts";

export const hardCap = 10;

export interface ShouldRejectByCapOptions {
	manual?: boolean;
	reason?: CompactionReason;
}

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

export function shouldRejectByCap(
	state: CompactionExtensionState,
	_opts?: ShouldRejectByCapOptions,
): { cancel: boolean } {
	return { cancel: isOverHardCap(state) };
}
