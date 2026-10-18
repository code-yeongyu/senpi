/**
 * What every monitor source shares: the events a watch emits, the snapshot the footer and the manifest
 * read, the stable `mon_` identity, and the record contract plus host hooks a source (command, file)
 * uses to emit through the registry's one sink (fire stats, wake budget, ended observers).
 */
import { randomBytes } from "node:crypto";
import type {
	TerminalMonitorEndedEvent as MonitorEndedEvent,
	TerminalMonitorEndedReason as MonitorEndedReason,
} from "../monitor-state-event.ts";

export interface MonitorLineEvent {
	readonly type: "line";
	readonly id: string;
	readonly description: string;
	readonly line: string;
	/** The line came from a human-input watch: a person's words, not machine status. */
	readonly humanInput?: true;
}

export interface MonitorSummaryEvent {
	readonly type: "summary";
	readonly id: string;
	readonly description: string;
	readonly summary: string;
}

export type MonitorEvent = MonitorLineEvent | MonitorSummaryEvent;

export type MonitorRearmResult = "rearmed" | "not_paused" | "not_found";

export interface MonitorResumeResult {
	readonly id: string;
	readonly mutedDropped: number;
}

const MONITOR_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Allocate a stable monitor identity: "mon_" + 16 Crockford base-32 chars (80 random bits). */
export function allocateMonitorId(): string {
	let id = "mon_";
	let buffer = 0;
	let bits = 0;
	for (const byte of randomBytes(10)) {
		buffer = (buffer << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			id += MONITOR_ID_ALPHABET[(buffer >> bits) & 31];
		}
	}
	return id;
}

export type MonitorFireWindow = { startMs: number; count: number };
export interface MonitorSnapshotEntry {
	readonly id: string;
	/** Stable "mon_" identity carried alongside the runtime id; always set on live snapshots. */
	readonly monitorId?: string;
	readonly description: string;
	readonly paused: boolean;
	/** Epoch milliseconds when the watch registered; feeds the footer's live elapsed label. */
	readonly startedAtMs: number;
	readonly command?: string | null;
	readonly filter?: string | null;
	readonly persistent?: boolean;
	readonly deadlineMs?: number | null;
	readonly fireCount?: number;
	readonly lastFiredAtMs?: number | null;
	/** Durability deadline of a restart-surviving watch; undefined for every ephemeral one. */
	readonly expiresAt?: number;
	readonly fireWindow?: MonitorFireWindow;
}

export type { MonitorEndedEvent, MonitorEndedReason };

/** The fields the registry reads off any live watch, whichever source owns it. */
export interface MonitorRecordBase {
	readonly id: string;
	readonly monitorId: string;
	readonly description: string;
	readonly startedAtMs: number;
	readonly command: string | null;
	readonly filter: RegExp | undefined | null;
	readonly persistent: boolean;
	readonly deadlineMs: number | null;
	fireCount: number;
	lastFiredAtMs: number | null;
	readonly expiresAt: number | undefined;
	paused: boolean;
	settled: boolean;
}

/** The registry's side of a source: one emit path, the ended observer and the change notification. */
export interface MonitorSourceHost {
	emit(record: MonitorRecordBase, event: MonitorEvent): void;
	/** Straight to the sink, outside any record's fire stats (a watch that never registered). */
	emitRaw(event: MonitorEvent): void;
	ended(record: MonitorRecordBase, reason: MonitorEndedReason, exitCode: number | null): void;
	changed(): void;
}
