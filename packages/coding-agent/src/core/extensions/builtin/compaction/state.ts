export interface CompactionExtensionState {
	turnCount: number;
}

export function createInitialState(): CompactionExtensionState {
	return { turnCount: 0 };
}

export function resetTurnCounter(state: CompactionExtensionState): CompactionExtensionState {
	return { ...state, turnCount: 0 };
}
