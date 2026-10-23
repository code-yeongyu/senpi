import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { parseSessionEntryLine } from "../session-entry-file.ts";
import type { FileEntry } from "../session-manager.ts";
import type { IndexedEntry } from "./index-record.ts";

export interface SessionFileIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
}

export function statSessionFile(sessionFile: string): SessionFileIdentity | undefined {
	if (!existsSync(sessionFile)) return undefined;
	const fd = openSync(sessionFile, "r");
	try {
		const { dev, ino, size } = fstatSync(fd);
		return { dev, ino, size };
	} finally {
		closeSync(fd);
	}
}

/**
 * The entry `record` points at, read by position, or undefined when that line no longer holds an entry with the
 * record's id and type. With `requireNewline` the line must also be complete, which is how a saved boundary is checked.
 */
export function readIndexedLine(
	sessionFile: string,
	record: IndexedEntry,
	requireNewline: boolean,
): FileEntry | undefined {
	if (!existsSync(sessionFile)) return undefined;
	const fd = openSync(sessionFile, "r");
	try {
		const want = record.length + (requireNewline ? 1 : 0);
		const bytes = Buffer.allocUnsafe(want);
		if (readSync(fd, bytes, 0, want, record.offset) !== want) return undefined;
		if (requireNewline && bytes[record.length] !== 10) return undefined;
		const entry = parseSessionEntryLine(bytes.subarray(0, record.length).toString("utf8"));
		return entry !== null && entry.id === record.id && entry.type === record.type ? entry : undefined;
	} finally {
		closeSync(fd);
	}
}
