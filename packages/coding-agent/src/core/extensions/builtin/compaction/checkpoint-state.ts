export interface AgentCheckpoint {
	timestamp: number;
}

export function captureAgentCheckpoint(): AgentCheckpoint {
	return { timestamp: 0 };
}

export function persistCheckpoint(_checkpoint: AgentCheckpoint): void {}

export function getLatestCheckpoint(): AgentCheckpoint | undefined {
	return undefined;
}

export function injectRestorationDirective(_checkpoint: AgentCheckpoint): string {
	return "";
}
