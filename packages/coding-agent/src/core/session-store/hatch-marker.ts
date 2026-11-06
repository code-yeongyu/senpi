import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { nodeJsonlHatchEnabled } from "./node-guard.ts";

/**
 * K9-F2 (senpi#5822): after a write by the Node developer hatch, records the session file's size and mtime in S07's
 * hatch marker (`<file>.k9f2`, read by `session-import/jsonl-import.ts`). The next Bun open can then tell the hatch's own
 * writes from any other change made outside the store. Does nothing outside the hatch.
 */
export function markHatchWrite(sessionFile: string): void {
	if (!nodeJsonlHatchEnabled()) return;
	const { size, mtimeMs } = statSync(sessionFile);
	const marker = `${sessionFile}.k9f2`;
	const temporary = `${marker}.${randomUUID()}`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeSync(fd, JSON.stringify({ size, mtimeMs }));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(temporary, marker);
	} finally {
		rmSync(temporary, { force: true });
	}
}
