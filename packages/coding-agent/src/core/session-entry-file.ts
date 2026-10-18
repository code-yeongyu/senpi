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
import type { FileEntry } from "./session-manager.ts";

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
export function loadEntriesFromFile(filePath: string): FileEntry[] {
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
		closeSync(fd);
	}
	return acceptSessionEntries(entries);
}

/**
 * `loadEntriesFromFile` without holding the event loop: the same entries, read with
 * asynchronous I/O and parsed in slices that yield once `slicer`'s budget is spent.
 */
export async function loadEntriesFromFileAsync(
	filePath: string,
	slicer: EventLoopSlicer = new EventLoopSlicer(),
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
		await handle.close();
	}
	return acceptSessionEntries(entries);
}

/**
 * Make this process's appends start on a new line. A final line with no newline is either a whole entry written
 * without one (it parses: it is terminated and kept) or a line a crash tore part-way (it does not parse: it was
 * never committed, so the file is cut back to its last complete line, senpi#3549). Terminating a torn line instead
 * would turn it into a complete, corrupt line that no reader can tell from real corruption. Only the final
 * segment is read, never the whole transcript; anything but a regular file is left to the loader, as before.
 */
export function terminateFinalSessionLine(filePath: string): void {
	if (!existsSync(filePath) || !statSync(filePath).isFile()) return;
	const fd = openSync(filePath, "r+");
	try {
		const size = fstatSync(fd).size;
		const segmentStart = finalSegmentStart(fd, size);
		if (segmentStart === size) return;
		const segment = Buffer.alloc(size - segmentStart);
		readSync(fd, segment, 0, segment.length, segmentStart);
		if (parseSessionEntryLine(segment.toString("utf8")) === null) ftruncateSync(fd, segmentStart);
		else writeSync(fd, "\n", size);
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
