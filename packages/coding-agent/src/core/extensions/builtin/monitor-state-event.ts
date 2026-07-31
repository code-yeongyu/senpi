export const TERMINAL_MONITOR_STATE_EVENT = "terminal_monitor_state";

/** One live watch as broadcast on the monitor state event; mirrors MonitorSnapshotEntry. */
export interface TerminalMonitorStateMonitorEntry {
	readonly id: string;
	readonly description: string;
	readonly paused: boolean;
	/** Epoch milliseconds when the watch registered; lets consumers render their own elapsed labels. */
	readonly startedAtMs: number;
}

export interface TerminalMonitorStateEvent {
	readonly activeCount: number;
	/** Per-watch detail for consumers that need more than the count; absent in pre-enrichment payloads. */
	readonly monitors?: readonly TerminalMonitorStateMonitorEntry[];
}

export function isTerminalMonitorStateEvent(data: unknown): data is TerminalMonitorStateEvent {
	return (
		typeof data === "object" &&
		data !== null &&
		"activeCount" in data &&
		typeof data.activeCount === "number" &&
		Number.isInteger(data.activeCount) &&
		data.activeCount >= 0
	);
}
