/**
 * Reading a session JSONL file into entries, shared by the synchronous loader and the
 * time-sliced one a multi-session host uses, so both parse byte-for-byte the same way.
 *
 * A host runs every session on one event loop: parsing a 231 MB transcript in one go held
 * every other session's requests for seconds (senpi#3518). `loadEntriesFromFileAsync` reads
 * with asynchronous I/O and hands the loop back whenever its slice budget is spent.
 */
import { closeSync, existsSync, fstatSync, ftruncateSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { normalizePath } from "../utils/paths.ts";
import { EventLoopSlicer } from "./event-loop-slicer.ts";
import { captureAndCloseFileIdentity, captureFileIdentity, loadedFileIdentities } from "./session-file-identity.ts";
import type { FileEntry } from "./session-manager.ts";
import { backupTornBytes, type SessionRecovery, type SessionRecoveryCause } from "./session-write-recovery.ts";

export const SESSION_READ_BUFFER_SIZE = 1024 * 1024;

export function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		// Skip malformed lines
		return null;
	}
}

export class SessionLineSplitter {
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";

	push(chunk: Buffer): string[] {
		this.pending += this.decoder.write(chunk);
		const lines: string[] = [];
		let lineStart = 0;
		let newlineIndex = this.pending.indexOf("\n", lineStart);
		while (newlineIndex !== -1) {
			lines.push(this.pending.slice(lineStart, newlineIndex));
			lineStart = newlineIndex + 1;
			newlineIndex = this.pending.indexOf("\n", lineStart);
		}
		this.pending = this.pending.slice(lineStart);
		return lines;
	}

	finish(): string {
		return this.pending + this.decoder.end();
	}
}

function acceptSessionEntries(entries: FileEntry[]): FileEntry[] {
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header?.type !== "session" || typeof header.id !== "string") return [];
	return entries;
}

/** Exported for testing */
export function loadEntriesFromFile(filePath: string, captureIdentity = false): FileEntry[] {
	return acceptSessionEntries(readRawEntriesFromFile(filePath, captureIdentity));
}

/** What `forkFrom` found in its source: the entries, whether the file had a header, and why it cannot be forked. */
export type ForkSource =
	| { readonly kind: "session"; readonly entries: FileEntry[] }
	| { readonly kind: "headerless"; readonly entries: FileEntry[] }
	| { readonly kind: "empty" }
	| { readonly kind: "not-a-session" };

const isSessionShapedEntry = (entry: FileEntry): boolean => {
	const candidate = entry as { type?: unknown; id?: unknown; parentId?: unknown };
	return (
		typeof candidate.type === "string" &&
		candidate.type !== "session" &&
		typeof candidate.id === "string" &&
		(candidate.parentId === null || typeof candidate.parentId === "string")
	);
};

/**
 * Read the source of a fork. A file whose line-1 header was lost but whose every other line is a session
 * entry (`type`, `id`, `parentId`) is still a whole conversation, and a fork writes its own new header anyway,
 * so it is forked rather than refused (omo#10375). Anything else that is not a headed session is reported as
 * what it is: no parsable line at all is empty, parsable lines of another shape are not a session.
 */
export function readForkSource(filePath: string): ForkSource {
	const raw = readRawEntriesFromFile(filePath);
	if (raw.length === 0) return { kind: "empty" };
	const accepted = acceptSessionEntries(raw);
	if (accepted.length > 0) return { kind: "session", entries: accepted };
	if (raw.every(isSessionShapedEntry)) return { kind: "headerless", entries: raw };
	return { kind: "not-a-session" };
}

function readRawEntriesFromFile(filePath: string, captureIdentity = false): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	const splitter = new SessionLineSplitter();
	const fd = openSync(resolvedFilePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			for (const line of splitter.push(buffer.subarray(0, bytesRead))) {
				const entry = parseSessionEntryLine(line);
				if (entry) entries.push(entry);
			}
		}
		const finalEntry = parseSessionEntryLine(splitter.finish());
		if (finalEntry) entries.push(finalEntry);
	} finally {
		if (captureIdentity) loadedFileIdentities.set(entries, captureAndCloseFileIdentity(fd, resolvedFilePath));
		else closeSync(fd);
	}
	return entries;
}

/**
 * `loadEntriesFromFile` without holding the event loop: the same entries, read with
 * asynchronous I/O and parsed in slices that yield once `slicer`'s budget is spent.
 */
export async function loadEntriesFromFileAsync(
	filePath: string,
	slicer: EventLoopSlicer = new EventLoopSlicer(),
	captureIdentity = false,
): Promise<FileEntry[]> {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	const splitter = new SessionLineSplitter();
	const handle = await open(resolvedFilePath, "r");
	try {
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			for (const line of splitter.push(buffer.subarray(0, bytesRead))) {
				const entry = parseSessionEntryLine(line);
				if (entry) entries.push(entry);
				if (slicer.due) await slicer.yield();
			}
		}
		const finalEntry = parseSessionEntryLine(splitter.finish());
		if (finalEntry) entries.push(finalEntry);
	} finally {
		if (captureIdentity) {
			const identity = captureFileIdentity(handle.fd, resolvedFilePath);
			loadedFileIdentities.set(entries, identity);
			await identity;
		}
		await handle.close();
	}
	return acceptSessionEntries(entries);
}

/** A torn final line was set aside, or could not be (the copy was refused) and must be set aside before the next append. */
export type FinalLineRepair =
	| { readonly kind: "set_aside"; readonly recovery: SessionRecovery }
	| { readonly kind: "deferred" };

/**
 * Make this process's appends start on a new line. A final line with no newline is either a whole entry written
 * without one (it parses: it is terminated and kept) or a line a crash tore part-way (it does not parse: it was
 * never committed, so it is copied to `<file>.torn-<time>` and the file is cut back to its last complete line,
 * senpi#3549, senpi#4295). Terminating a torn line instead would turn it into a complete, corrupt line that no reader
 * can tell from real corruption. Only the final segment is read, never the whole transcript; anything but a regular
 * file is left to the loader, as before.
 */
export function terminateFinalSessionLine(
	filePath: string,
	cause: SessionRecoveryCause = "unknown",
): FinalLineRepair | undefined {
	if (!existsSync(filePath) || !statSync(filePath).isFile()) return undefined;
	const fd = openSync(filePath, "r+");
	try {
		const size = fstatSync(fd).size;
		const segmentStart = finalSegmentStart(fd, size);
		if (segmentStart === size) return undefined;
		const segment = Buffer.alloc(size - segmentStart);
		readSync(fd, segment, 0, segment.length, segmentStart);
		if (parseSessionEntryLine(segment.toString("utf8")) !== null) {
			writeSync(fd, "\n", size);
			return undefined;
		}
		let recovery: SessionRecovery;
		try {
			recovery = backupTornBytes(filePath, segment, cause);
		} catch (error) {
			// Deferred, not dropped: a full disk can refuse the copy, so the file is left as it is and the writer
			// sets the tail aside before its first append, which fails with this error if the disk is still full.
			if (error instanceof Error) return { kind: "deferred" };
			throw error;
		}
		// Not synced on purpose: a lost truncate only brings back an uncommitted tail, and the next append syncs.
		ftruncateSync(fd, segmentStart);
		return { kind: "set_aside", recovery };
	} finally {
		closeSync(fd);
	}
}

/** The offset just after the file's last newline (0 when it has none); `size` when it ends in one. */
function finalSegmentStart(fd: number, size: number): number {
	const chunk = Buffer.alloc(Math.min(64 * 1024, size));
	let end = size;
	while (end > 0) {
		const start = Math.max(0, end - chunk.length);
		const read = readSync(fd, chunk, 0, end - start, start);
		const newline = chunk.subarray(0, read).lastIndexOf(10);
		if (newline >= 0) return start + newline + 1;
		end = start;
	}
	return 0;
}
