import type {
	FileMonitorDirectoryIdentity,
	FileMonitorEntry,
	FileMonitorRegistryDependencies,
	FileMonitorWatcher,
} from "./file-monitor-runtime.ts";
import type { SecureFileMonitorWorkerRegistration } from "./secure-file-monitor-worker-protocol.ts";

export type FileMonitorEvent = "create" | "modify";
export type FileMonitorRearmResult = "rearmed" | "not_paused" | "not_found";

export interface RegisterFileMonitorOptions {
	readonly description: string;
	readonly path: string;
	readonly displayPath?: string;
	readonly logicalParent?: string;
	readonly parentIdentity?: FileMonitorDirectoryIdentity;
	readonly event: FileMonitorEvent;
	readonly timeoutMs: number;
	readonly onBeforeWatch?: (id: string) => void;
}

export interface FileMonitorSnapshotEntry {
	readonly id: string;
	readonly description: string;
	readonly paused: boolean;
	readonly startedAtMs: number;
}

export interface FileMonitorRecordBase extends FileMonitorSnapshotEntry {
	readonly path: string;
	readonly displayPath: string;
	readonly logicalParent: string;
	readonly event: FileMonitorEvent;
	readonly parentIdentity: FileMonitorDirectoryIdentity;
	paused: boolean;
	settled: boolean;
}

export interface LegacyFileMonitorRecord extends FileMonitorRecordBase {
	readonly backend: "legacy";
	readonly baseline: FileMonitorEntry | undefined;
	readonly watcher: FileMonitorWatcher;
	reconcileQueued: boolean;
	stopPolling: (() => void) | undefined;
	timer: ReturnType<typeof setTimeout> | undefined;
}

export interface SecureFileMonitorRecord extends FileMonitorRecordBase {
	readonly backend: "secure";
	readonly registration: SecureFileMonitorWorkerRegistration;
}

export type FileMonitorRecord = LegacyFileMonitorRecord | SecureFileMonitorRecord;

export interface FileMonitorRegistryOptions extends FileMonitorRegistryDependencies {
	readonly emitLine: (id: string, description: string, line: string) => void;
	readonly emitSummary: (id: string, description: string, summary: string) => void;
	readonly onChange: () => void;
	readonly maxSessions?: number;
}
