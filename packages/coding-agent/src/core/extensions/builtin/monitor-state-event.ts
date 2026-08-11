export const TERMINAL_MONITOR_STATE_EVENT = "terminal_monitor_state";
export const WAKE_SOURCE_STATE_EVENT = "wake_source_state";

export interface WakeSourceStateItem {
	readonly id: string;
	readonly description?: string;
	readonly startedAtMs?: number;
}

export interface WakeSourceStateEvent {
	readonly source: string;
	readonly activeCount: number;
	readonly items?: readonly WakeSourceStateItem[];
}

/**
 * Deliberately validates only the shared cross-package fields. Emitters may add
 * source-specific details such as `channels` or `monitors`.
 */
export function isWakeSourceStateEvent(data: unknown): data is WakeSourceStateEvent {
	return (
		typeof data === "object" &&
		data !== null &&
		"source" in data &&
		typeof data.source === "string" &&
		data.source.length > 0 &&
		"activeCount" in data &&
		typeof data.activeCount === "number" &&
		Number.isFinite(data.activeCount)
	);
}

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
