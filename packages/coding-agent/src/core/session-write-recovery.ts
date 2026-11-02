import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, ftruncateSync, openSync, readSync, rmSync } from "node:fs";
import { type FileHandle, rm } from "node:fs/promises";
import { shortenPath } from "../utils/paths.ts";
import { replaceFileAtomically } from "./session-file-replace.ts";

const NEWLINE = 0x0a;
const SCAN_CHUNK_BYTES = 64 * 1024;
const DISK_FULL_CODES = new Set(["ENOSPC", "EDQUOT"]);

/** Why a session file's tail was set aside: a write that hit a full disk, any other failed write, or found on open. */
export type SessionRecoveryCause = "disk_full" | "write_failed" | "unknown";

/** One repair of a session file: the incomplete bytes were copied to `backupPath` (never deleted) and cut. */
export interface SessionRecovery {
	readonly cause: SessionRecoveryCause;
	readonly backupPath: string;
	readonly droppedBytes: number;
	/** The one-time notice for the person. */
	readonly notice: string;
}

export function sessionRecoveryCause(error: unknown): SessionRecoveryCause {
	let current: unknown = error;
	for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
		if ("code" in current && typeof current.code === "string" && DISK_FULL_CODES.has(current.code))
			return "disk_full";
		current = current.cause;
	}
	return "write_failed";
}

function recoveryNotice(cause: SessionRecoveryCause, backupPath: string): string {
	const shortened = shortenPath(backupPath);
	const backup = shortened.startsWith("~/") || shortened.startsWith("~\\") ? shortened : "a session recovery backup";
	if (cause === "disk_full") {
		return `The last message wasn't saved because the disk was full. Free disk space to keep saving this session; the incomplete record was kept in ${backup}.`;
	}
	if (cause === "write_failed") {
		return `The last message wasn't saved because writing the session file failed. The incomplete record was kept in ${backup}.`;
	}
	return `The last message of this session wasn't saved completely (an earlier save was interrupted, for example by a full disk). Everything before it was loaded; the incomplete record was kept in ${backup}.`;
}

/**
 * Copies torn bytes to `<path>.torn-<time>-<id>` through the atomic session-file writer (temp file, fsync, rename),
 * so a full disk leaves no partial copy, and returns the recovery to report. Throws when the copy is refused.
 */
export function backupTornBytes(path: string, bytes: Buffer, cause: SessionRecoveryCause): SessionRecovery {
	const backupPath = `${path}.torn-${Date.now()}-${randomUUID().slice(0, 8)}`;
	replaceFileAtomically(backupPath, [bytes]);
	return { cause, backupPath, droppedBytes: bytes.length, notice: recoveryNotice(cause, backupPath) };
}

/**
 * Cuts a JSONL session file back to its last complete line, first copying what it cuts aside (senpi#4295). An append
 * that failed part-way (ENOSPC) can leave a partial line, and the next append would be glued onto it, losing both
 * entries on reload. A file that already ends in a newline is left untouched and returns undefined; a refused copy
 * throws before anything is cut.
 */
export function truncateToLastCompleteLine(path: string, cause: SessionRecoveryCause): SessionRecovery | undefined {
	const fd = openSync(path, "r+");
	try {
		const size = fstatSync(fd).size;
		const chunk = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, size));
		const tail: Buffer[] = [];
		let end = size;
		while (end > 0) {
			const start = Math.max(0, end - chunk.length);
			const read = readSync(fd, chunk, 0, end - start, start);
			const newline = chunk.subarray(0, read).lastIndexOf(NEWLINE);
			if (newline >= 0) {
				const completeLength = start + newline + 1;
				if (completeLength >= size) return undefined;
				tail.unshift(Buffer.from(chunk.subarray(newline + 1, read)));
				const recovery = backupTornBytes(path, Buffer.concat(tail), cause);
				ftruncateSync(fd, completeLength);
				return recovery;
			}
			tail.unshift(Buffer.from(chunk.subarray(0, read)));
			end = start;
		}
		return undefined;
	} finally {
		closeSync(fd);
	}
}

/**
 * Closes and removes a session file whose first flush failed part-way, then rethrows the write
 * error. The first flush creates the file exclusively, so a partial file left behind would fail
 * every later flush with EEXIST while memory kept growing. A failed close does not skip the
 * removal; any cleanup failure is thrown together with the write error.
 */
export function discardFailedFirstFlush(path: string, fd: number, writeError: unknown): never {
	const cleanupErrors: unknown[] = [];
	try {
		closeSync(fd);
	} catch (closeError) {
		cleanupErrors.push(closeError);
	}
	try {
		rmSync(path, { force: true });
	} catch (removeError) {
		cleanupErrors.push(removeError);
	}
	throwWriteError(path, writeError, cleanupErrors);
}

/**
 * `discardFailedFirstFlush` for the asynchronous header write: closes `handle` (when it is still open)
 * and removes the file that write created, then rethrows the write error.
 */
export async function discardFailedFirstFlushAsync(
	path: string,
	handle: FileHandle | undefined,
	writeError: unknown,
): Promise<never> {
	const cleanupErrors: unknown[] = [];
	if (handle !== undefined) {
		try {
			await handle.close();
		} catch (closeError) {
			cleanupErrors.push(closeError);
		}
	}
	try {
		await rm(path, { force: true });
	} catch (removeError) {
		cleanupErrors.push(removeError);
	}
	throwWriteError(path, writeError, cleanupErrors);
}

function throwWriteError(path: string, writeError: unknown, cleanupErrors: readonly unknown[]): never {
	if (cleanupErrors.length > 0) {
		throw new AggregateError(
			[writeError, ...cleanupErrors],
			`Session file write failed and the partial file ${path} could not be cleaned up`,
		);
	}
	throw writeError;
}
