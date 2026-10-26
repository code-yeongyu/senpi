import { readFile, unlink, writeFile } from "node:fs/promises";

/**
 * The asynchronous file seam of compact current-state storage (senpi#4272) and the failures it
 * reports. Every spool access goes through `CompactStorageIo`; nothing here blocks the host loop.
 */

export type CompactStorageOperation =
	| "spool_create"
	| "spill_write"
	| "page_write"
	| "leaf_read"
	| "page_read"
	| "reclaim";

export interface CompactStorageFailure {
	readonly operation: CompactStorageOperation;
	readonly path: string;
	readonly cause: string;
	/** Accepted bytes this failure leaves resident in memory instead of on disk. */
	readonly retainedInMemoryBytes: number;
}

/** Asynchronous file access the host supplies; the default is node's promise filesystem. */
export interface CompactStorageIo {
	writeFile(path: string, data: Buffer): Promise<void>;
	readFile(path: string): Promise<Buffer>;
	unlink(path: string): Promise<void>;
}

export const nodeCompactStorageIo: CompactStorageIo = {
	writeFile: (path, data) => writeFile(path, data, { flag: "wx", mode: 0o600 }),
	readFile: (path) => readFile(path),
	unlink: (path) => unlink(path),
};

/** Never throws: a host-supplied cause that cannot be described must not abort the failure report. */
export function describeCause(cause: unknown): string {
	try {
		return cause instanceof Error ? cause.message : String(cause);
	} catch {
		return "unprintable failure cause";
	}
}

/** Committed storage that can no longer be read: a real error, never empty content. */
export class CompactStorageReadError extends Error {
	readonly operation: CompactStorageOperation;
	readonly path: string;

	constructor(operation: CompactStorageOperation, path: string, cause: unknown) {
		super(`compact storage ${operation} failed for ${path}: ${describeCause(cause)}`, { cause });
		this.name = "CompactStorageReadError";
		this.operation = operation;
		this.path = path;
	}
}
