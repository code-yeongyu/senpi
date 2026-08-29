export interface MonitorLineEvent {
	readonly type: "line";
	readonly id: string;
	readonly description: string;
	readonly line: string;
}

export interface MonitorSummaryEvent {
	readonly type: "summary";
	readonly id: string;
	readonly description: string;
	readonly summary: string;
}

export type MonitorEvent = MonitorLineEvent | MonitorSummaryEvent;
export type MonitorRearmResult = "rearmed" | "not_paused" | "not_found";

export interface MonitorSnapshotEntry {
	readonly id: string;
	readonly description: string;
	readonly paused: boolean;
	readonly startedAtMs: number;
}

export interface MonitorRegistryOptions {
	readonly getTerminalSessionCount?: () => number;
	readonly onChange?: (snapshot: readonly MonitorSnapshotEntry[]) => void;
	readonly maxSessions?: number;
	readonly fileMonitor?: FileMonitorRegistryDependencies;
}

export interface RegisterMonitorOptions {
	readonly id: string;
	readonly description: string;
	readonly runtime: TerminalRuntimeSession;
	readonly filter?: RegExp;
	readonly onBeforeEvents?: (id: string) => void;
}

export interface MonitorRecord {
	readonly id: string;
	readonly description: string;
	readonly startedAtMs: number;
	readonly runtime: TerminalRuntimeSession;
	readonly filter: RegExp | undefined;
	lineBuffer: string;
	paused: boolean;
	settled: boolean;
	unsubscribeOutput: (() => void) | undefined;
	unsubscribeExit: (() => void) | undefined;
}

import type { FileMonitorRegistryDependencies } from "./file-monitor-registry.ts";
import type { TerminalRuntimeSession } from "./runtime-session.ts";
