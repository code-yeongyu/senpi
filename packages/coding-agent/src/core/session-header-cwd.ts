import { open } from "node:fs/promises";
import { parseSessionEntryLine, SESSION_READ_BUFFER_SIZE, SessionLineSplitter } from "./session-entry-file.ts";

/** A header is almost always in the first chunk. */
const CHUNK_BYTES = 4096;
/** Past this much without a header (a very long first line) the scan reads in the loader's own chunks. */
const SMALL_SCAN_BYTES = 1024 * 1024;

/** Keep scanning (`undefined`), or the folder of the first entry, which is `undefined` when it names none. */
function candidate(line: string): { readonly cwd: string | undefined } | undefined {
	const entry = parseSessionEntryLine(line);
	if (!entry) return undefined;
	if (entry.type !== "session" || typeof entry.id !== "string") return { cwd: undefined };
	const { cwd } = entry;
	return { cwd: typeof cwd === "string" && cwd !== "" ? cwd : undefined };
}

/**
 * The folder a session file's header names, read as the session manager finds that header: blank and unparseable
 * leading lines are skipped, and the first parsed entry decides (`session-manager.ts`, `readSessionHeader`).
 * `undefined` when there is no file yet (ENOENT, ENOTDIR) or the file names no folder; every other failure to read an
 * existing file throws, so a caller never mistakes an unreadable file for one that names nothing.
 *
 * The scan has no bound of its own: it reads on until the first entry that parses, however far in that is, and stops
 * there. So a header behind a very long first line is still found (senpi#6427), and nothing after it is read or
 * parsed: the open that follows loads the transcript once, not twice.
 */
export async function readHeaderCwd(sessionFile: string): Promise<string | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(sessionFile, "r");
	} catch (error) {
		const { code } = error as NodeJS.ErrnoException;
		if (code === "ENOENT" || code === "ENOTDIR") return undefined;
		throw error;
	}
	try {
		const splitter = new SessionLineSplitter();
		let buffer = Buffer.allocUnsafe(CHUNK_BYTES);
		let scanned = 0;
		while (true) {
			if (scanned >= SMALL_SCAN_BYTES && buffer.length === CHUNK_BYTES)
				buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) return candidate(splitter.finish())?.cwd;
			scanned += bytesRead;
			for (const line of splitter.push(buffer.subarray(0, bytesRead))) {
				const found = candidate(line);
				if (found) return found.cwd;
			}
		}
	} finally {
		await handle.close();
	}
}
