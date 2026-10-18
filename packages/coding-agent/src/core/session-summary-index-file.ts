import { appendFile, rename, rm, writeFile } from "fs/promises";
import { parseRepositoryIdentity } from "./repository-identity.ts";
import { readFileLines, type SessionSummary } from "./session-summary.ts";
import type { FileStamp } from "./session-summary-lru.ts";

/**
 * Name of the summary index inside the sessions directory it describes. The
 * extension is deliberately not `.jsonl`: every `*.jsonl` there is a session.
 */
export const SESSION_SUMMARY_INDEX_FILE = ".session-summaries.index";

// 2: summaries carry the recorded repository identity; a version-1 index predates it and is re-read.
const INDEX_VERSION = 2;
const HEADER_LINE = `${JSON.stringify({ version: INDEX_VERSION })}\n`;

/** One indexed session file: its basename, the stamp it was read at, and its summary. */
export type IndexEntry = {
	readonly file: string;
	readonly stamp: FileStamp;
	readonly summary: SessionSummary;
	/** Serialized line, newline included. */
	readonly line: string;
	readonly lineBytes: number;
};

/** An index as loaded from disk; an absent or unusable file loads as `usable: false`. */
export type LoadedIndex = {
	readonly usable: boolean;
	/** Deduplicated entries, last line wins. */
	readonly entries: ReadonlyMap<string, IndexEntry>;
	/** Bytes after the header line, including torn and superseded lines. */
	readonly entryBytes: number;
	/** False when the file ends in a torn line, so the next append must start a new line. */
	readonly endsWithNewline: boolean;
};

const UNUSABLE: LoadedIndex = { usable: false, entries: new Map(), entryBytes: 0, endsWithNewline: true };

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isOptional(value: unknown, type: "string" | "number"): boolean {
	return value === undefined || typeof value === type;
}

function isSessionSummary(value: unknown): value is SessionSummary {
	if (!isObject(value) || !isObject(value.header)) return false;
	return (
		value.header.type === "session" &&
		typeof value.header.id === "string" &&
		typeof value.firstUserMessage === "string" &&
		typeof value.messageCount === "number" &&
		typeof value.allMessagesText === "string" &&
		isOptional(value.name, "string") &&
		isOptional(value.lastActivityTime, "number") &&
		(value.repositoryIdentity === undefined || parseRepositoryIdentity(value.repositoryIdentity) !== undefined)
	);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Serialize one entry, or undefined when the summary would not survive a JSON round trip. */
export function toIndexEntry(file: string, stamp: FileStamp, summary: SessionSummary): IndexEntry | undefined {
	if (summary.lastActivityTime !== undefined && !Number.isFinite(summary.lastActivityTime)) return undefined;
	return withLine(
		file,
		stamp,
		summary,
		`${JSON.stringify({ file, size: stamp.size, mtimeMs: stamp.mtimeMs, summary })}\n`,
	);
}

function withLine(file: string, stamp: FileStamp, summary: SessionSummary, line: string): IndexEntry {
	return { file, stamp, summary, line, lineBytes: Buffer.byteLength(line, "utf8") };
}

function parseEntryLine(line: string): IndexEntry | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isObject(parsed) || typeof parsed.file !== "string" || parsed.file.includes("/")) return undefined;
	if (!isFiniteNumber(parsed.size) || !isFiniteNumber(parsed.mtimeMs) || !isSessionSummary(parsed.summary)) {
		return undefined;
	}
	return withLine(parsed.file, { size: parsed.size, mtimeMs: parsed.mtimeMs }, parsed.summary, `${line}\n`);
}

function isCurrentHeader(line: string): boolean {
	try {
		const parsed: unknown = JSON.parse(line);
		return isObject(parsed) && parsed.version === INDEX_VERSION;
	} catch {
		return false;
	}
}

/**
 * Load an index, tolerating every failure: a missing file, a missing or foreign
 * version header, or a read error loads as unusable; a line that does not parse
 * (a torn append, truncation, garbage) is skipped.
 */
export async function loadIndexFile(path: string): Promise<LoadedIndex> {
	const entries = new Map<string, IndexEntry>();
	let headerSeen = false;
	let headerBytes = 0;
	try {
		const read = await readFileLines(path, (line) => {
			if (!headerSeen) {
				headerSeen = true;
				headerBytes = Buffer.byteLength(line, "utf8") + 1;
				return isCurrentHeader(line);
			}
			const entry = parseEntryLine(line);
			if (entry) entries.set(entry.file, entry);
			return true;
		});
		if (!read.completed || !headerSeen) return UNUSABLE;
		return {
			usable: true,
			entries,
			entryBytes: Math.max(0, read.bytes - headerBytes),
			endsWithNewline: read.endsWithNewline,
		};
	} catch (error) {
		if (error instanceof Error) return UNUSABLE;
		throw error;
	}
}

/** Append entries one whole line per write, first closing a torn tail when there is one. */
export async function appendIndexEntries(
	path: string,
	entries: readonly IndexEntry[],
	endsWithNewline: boolean,
): Promise<void> {
	let prefix = endsWithNewline ? "" : "\n";
	for (const entry of entries) {
		await appendFile(path, prefix + entry.line);
		prefix = "";
	}
}

export async function rewriteIndexFile(path: string, entries: readonly IndexEntry[]): Promise<void> {
	const temp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
	try {
		await writeFile(temp, HEADER_LINE + entries.map((entry) => entry.line).join(""));
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true }).catch(() => undefined);
		throw error;
	}
}
