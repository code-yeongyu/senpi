import { writeSync } from "node:fs";

const EAGAIN_RETRY_MS = 1;

/**
 * One synchronous line, so a launcher exiting cannot truncate the caller's answer. `writeSync` on a
 * non-blocking pipe accepts only what fits the pipe buffer and returns that count (or throws EAGAIN), so
 * the write loops until every byte is out.
 */
export function emit(payload: Record<string, unknown>): void {
	writeAllSync(1, `${JSON.stringify(payload)}\n`);
}

export function writeAllSync(fd: number, text: string): void {
	const bytes = Buffer.from(text);
	let offset = 0;
	while (offset < bytes.length) {
		try {
			offset += writeSync(fd, bytes, offset);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, EAGAIN_RETRY_MS);
		}
	}
}
