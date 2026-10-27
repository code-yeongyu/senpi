import { open, readFile, unlink, writeFile } from "node:fs/promises";

/**
 * The asynchronous file seam of compact current-state storage (senpi#4272) and the failures it
 * reports. Every spool access goes through `CompactStorageIo`; nothing here blocks the host loop.
 */

export type CompactStorageOperation =
	| "spool_create"
	| "spill_write"
	| "value_write"
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

/** One leaf's bytes inside a segment file that packs a flush batch. */
export interface CompactFileRange {
	readonly offset: number;
	readonly length: number;
}

/** Asynchronous file access the host supplies; the default is node's promise filesystem. */
export interface CompactStorageIo {
	writeFile(path: string, data: Buffer): Promise<void>;
	/** The whole file, or at most `range.length` bytes from `range.offset`. */
	readFile(path: string, range?: CompactFileRange): Promise<Buffer>;
	unlink(path: string): Promise<void>;
}

export const nodeCompactStorageIo: CompactStorageIo = {
	writeFile: (path, data) => writeFile(path, data, { flag: "wx", mode: 0o600 }),
	readFile: async (path, range) => {
		if (!range) return readFile(path);
		const handle = await open(path, "r");
		try {
			const { buffer, bytesRead } = await handle.read(Buffer.alloc(range.length), 0, range.length, range.offset);
			return buffer.subarray(0, bytesRead);
		} finally {
			await handle.close();
		}
	},
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
