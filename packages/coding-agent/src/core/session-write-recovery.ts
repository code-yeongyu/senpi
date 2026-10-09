import { closeSync, fstatSync, ftruncateSync, openSync, readSync, rmSync } from "node:fs";
import { type FileHandle, rm } from "node:fs/promises";

const NEWLINE = 0x0a;
const SCAN_CHUNK_BYTES = 64 * 1024;

/**
 * Cuts a JSONL session file back to its last complete line. An append that failed part-way
 * (ENOSPC) can leave a partial line, and the next append would be glued onto it, losing both
 * entries on reload. A file that already ends in a newline is left untouched.
 */
export function truncateToLastCompleteLine(path: string): void {
	const fd = openSync(path, "r+");
	try {
		const size = fstatSync(fd).size;
		const chunk = Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, size));
		let end = size;
		while (end > 0) {
			const start = Math.max(0, end - chunk.length);
			const read = readSync(fd, chunk, 0, end - start, start);
			const newline = chunk.subarray(0, read).lastIndexOf(NEWLINE);
			if (newline >= 0) {
				const completeLength = start + newline + 1;
				if (completeLength < size) ftruncateSync(fd, completeLength);
				return;
			}
			end = start;
		}
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
