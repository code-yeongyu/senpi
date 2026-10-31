import type { FileSystem } from "../../types.ts";
import type { SessionCreateOptions, SessionMetadata } from "../types.ts";

export const JSONL_FORMAT_VERSION = 4;
export const JSONL_STORAGE_VERSION = 1;

export interface JsonlStorageHeader {
	v: typeof JSONL_FORMAT_VERSION;
	kind: "header";
	id: string;
	storageVersion: number;
	createdAt: number;
	cwd: string;
	parentSessionId?: string;
	legacyParentSessionPath?: string;
	/** Sequence high-water mark written by snapshot rewrites. */
	nextSeq?: number;
}

export interface JsonlStorageOptions {
	fileSystem: FileSystem;
	path: string;
	now?: () => number;
	/** Called once each time damaged records are set aside and the file is repaired; see {@link JsonlStorageRecovery}. */
	onRecovery?: (recovery: JsonlStorageRecovery) => void;
}

/** Why records were set aside: a failed append that hit a full disk, any other failed append, or damage found on open. */
export type JsonlRecoveryCause = "disk_full" | "write_failed" | "unknown";

/**
 * One repair of a session file: the damaged bytes were copied to `backupPath` (never deleted) and the file was
 * rewritten atomically with every record that still replays. `message` is the one-time notice for the user.
 */
export interface JsonlStorageRecovery {
	readonly path: string;
	readonly backupPath: string;
	readonly droppedRecords: number;
	readonly cause: JsonlRecoveryCause;
	readonly message: string;
}

export interface JsonlSessionMetadata extends SessionMetadata {
	cwd: string;
	path: string;
	/** Filesystem modification time as milliseconds since Unix epoch. */
	modifiedAt: number;
}

export interface JsonlSessionCreateOptions extends SessionCreateOptions {
	cwd: string;
}

export interface JsonlSessionListOptions {
	cwd?: string;
}

export interface JsonlSessionRepoOptions {
	fileSystem: FileSystem;
	sessionsRoot: string;
	now?: () => number;
	/** Passed to every session this repo opens or creates; see {@link JsonlStorageOptions.onRecovery}. */
	onRecovery?: (recovery: JsonlStorageRecovery) => void;
}
