/** A live file watch's record: its options, its proven identity and its check-loop state. */
import type { FSWatcher, Stats } from "node:fs";
import type { FileWatchLoop as FileWatchLoopType } from "./monitor-file-watch.ts";
import { FileWatchLoop } from "./monitor-file-watch.ts";
import { allocateMonitorId, type MonitorRecordBase } from "./monitor-types.ts";

export interface RegisterFileMonitorOptions {
	readonly description: string;
	readonly path: string;
	readonly persistent?: boolean;
	readonly deadlineMs?: number | null;
	/** Caller-supplied stable identity so a restore can re-bind the same "mon_" id. */
	readonly monitorId?: string;
	readonly event: "create" | "modify";
	readonly timeoutMs: number;
	readonly cwd: string;
	readonly approvedParent?: string;
	/** Durability deadline of a `checkpointed-file` watch; omitted for a one-shot ephemeral one. */
	readonly expiresAt?: number;
}

export interface FileMonitorRecord extends MonitorRecordBase {
	readonly id: string;
	readonly monitorId: string;
	readonly sessionId: string;
	readonly description: string;
	readonly startedAtMs: number;
	readonly command: null;
	readonly filter: null;
	readonly persistent: boolean;
	readonly deadlineMs: number | null;
	fireCount: number;
	lastFiredAtMs: number | null;
	readonly expiresAt: number | undefined;
	readonly path: string;
	readonly canonicalPath: string;
	readonly canonicalParent: string;
	readonly event: "create" | "modify";
	readonly watcher: FSWatcher;
	readonly release: () => void;
	readonly watch: FileWatchLoopType;
	paused: boolean;
	settled: boolean;
	present: boolean;
	mtimeMs: number;
	size: number;
	digest: string;
	device: number;
	inode: number;
	pendingChange: boolean;
	dirty: boolean;
	dirtyPasses: number;
	dirtyWindowStartedAt: number;
	checking: Promise<void> | undefined;
	/** Unset for a persistent watch: it has no live deadline, only its durability expiry. */
	readonly deadline: ReturnType<typeof setTimeout> | undefined;
}

export interface NewFileRecordInput {
	readonly id: string;
	readonly options: RegisterFileMonitorOptions;
	readonly path: string;
	readonly canonicalPath: string;
	readonly approvedParent: string;
	readonly watcher: FSWatcher;
	readonly release: (() => void) | undefined;
	readonly digest: string;
	readonly initial: Stats | null;
	/** Runs one check pass (the watch loop's trigger). */
	readonly check: () => void;
	/** The registration timeout elapsed for an ephemeral watch. */
	readonly timedOut: () => void;
}

export function newFileRecord(input: NewFileRecordInput): FileMonitorRecord {
	const { id, options, path, canonicalPath, approvedParent, watcher, release, digest, initial } = input;
	const persistent = options.persistent ?? options.expiresAt !== undefined;
	return {
		id,
		monitorId: options.monitorId ?? allocateMonitorId(),
		sessionId: id,
		description: options.description,
		startedAtMs: Date.now(),
		command: null,
		filter: null,
		persistent,
		deadlineMs: persistent ? null : (options.deadlineMs ?? Date.now() + options.timeoutMs),
		fireCount: 0,
		lastFiredAtMs: null,
		expiresAt: options.expiresAt,
		path,
		canonicalPath,
		canonicalParent: approvedParent,
		event: options.event,
		watcher,
		release: release ?? (() => {}),
		watch: new FileWatchLoop(input.check),
		paused: false,
		settled: false,
		present: initial !== null,
		mtimeMs: initial?.mtimeMs ?? 0,
		size: initial?.size ?? 0,
		digest,
		device: initial?.dev ?? 0,
		inode: initial?.ino ?? 0,
		pendingChange: false,
		dirty: false,
		dirtyPasses: 0,
		dirtyWindowStartedAt: 0,
		checking: undefined,
		deadline: persistent ? undefined : setTimeout(input.timedOut, options.timeoutMs),
	};
}
