export const TERMINAL_MONITOR_STATE_EVENT = "terminal_monitor_state";
export const TERMINAL_MONITOR_ENDED_EVENT = "terminal_monitor_ended";
export const WAKE_SOURCE_STATE_EVENT = "wake_source_state";
export const CONTINUATION_HOLD_STATE_EVENT = "continuation_hold_state";

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

export interface ContinuationHoldStateEvent {
	readonly source: string;
	readonly active: boolean;
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

export function isContinuationHoldStateEvent(data: unknown): data is ContinuationHoldStateEvent {
	return (
		typeof data === "object" &&
		data !== null &&
		"source" in data &&
		typeof data.source === "string" &&
		data.source.length > 0 &&
		"active" in data &&
		typeof data.active === "boolean"
	);
}

/** One live watch as broadcast on the monitor state event; mirrors MonitorSnapshotEntry. */
export interface TerminalMonitorStateMonitorEntry {
	readonly id: string;
	/** Stable "mon_" identity surviving runtime id churn; absent in pre-enrichment payloads. */
	readonly monitorId?: string;
	readonly description: string;
	readonly paused: boolean;
	/** Epoch milliseconds when the watch registered; lets consumers render their own elapsed labels. */
	readonly startedAtMs: number;
	readonly command?: string | null;
	readonly filter?: string | null;
	readonly persistent?: boolean;
	readonly deadlineMs?: number | null;
	readonly fireCount?: number;
	readonly lastFiredAtMs?: number | null;
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

export type TerminalMonitorEndedReason = "exit" | "timeout" | "killed" | "disposed";
export interface TerminalMonitorEndedEvent {
	readonly id: string;
	readonly description: string;
	readonly startedAtMs: number;
	readonly endedAtMs: number;
	readonly reason: TerminalMonitorEndedReason;
	readonly exitCode: number | null;
	readonly fireCount: number;
}
export function isTerminalMonitorEndedEvent(data: unknown): data is TerminalMonitorEndedEvent {
	return (
		typeof data === "object" &&
		data !== null &&
		"id" in data &&
		typeof data.id === "string" &&
		"description" in data &&
		typeof data.description === "string" &&
		"startedAtMs" in data &&
		typeof data.startedAtMs === "number" &&
		Number.isFinite(data.startedAtMs) &&
		"endedAtMs" in data &&
		typeof data.endedAtMs === "number" &&
		Number.isFinite(data.endedAtMs) &&
		"exitCode" in data &&
		(data.exitCode === null || (typeof data.exitCode === "number" && Number.isInteger(data.exitCode))) &&
		"fireCount" in data &&
		typeof data.fireCount === "number" &&
		Number.isInteger(data.fireCount) &&
		data.fireCount >= 0 &&
		"reason" in data &&
		(data.reason === "exit" || data.reason === "timeout" || data.reason === "killed" || data.reason === "disposed")
	);
}
