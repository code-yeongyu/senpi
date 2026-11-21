import { writeSync } from "node:fs";

/**
 * One synchronous line, so a launcher exiting cannot truncate the caller's answer.
 *
 * A pipe stdout is non-blocking once the runtime has touched `process.stdout`, so one `writeSync` may take only what
 * fits in the pipe buffer (64 KiB) or throw `EAGAIN` while it is full: keep writing the rest until every byte is out.
 */
export function emit(payload: Record<string, unknown>): void {
	const bytes = Buffer.from(`${JSON.stringify(payload)}\n`);
	let sleeper: Int32Array | undefined;
	for (let offset = 0; offset < bytes.length;) {
		try {
			offset += writeSync(1, bytes, offset);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error;
			sleeper ??= new Int32Array(new SharedArrayBuffer(4));
			Atomics.wait(sleeper, 0, 0, 1);
		}
	}
}
