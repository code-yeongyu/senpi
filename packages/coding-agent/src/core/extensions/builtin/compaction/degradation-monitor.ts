export function handleMessageEnd(): void {}

export function handleTurnEnd(): void {}

export interface DegradationMonitorState {
	degraded: boolean;
}

export function createDegradationMonitorState(): DegradationMonitorState {
	return { degraded: false };
}
