import { open } from "node:fs/promises";
import { parseSessionEntryLine, SessionLineSplitter } from "./session-entry-file.ts";
import { loadEntriesFromFileAsync } from "./session-manager.ts";

/** The same bounds the session manager scans a header with (`readSessionHeader`). */
const SCAN_LIMIT_BYTES = 1024 * 1024;
const CHUNK_BYTES = 4096;

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
 * The bounded scan is a discovery step, not the answer: a file whose header lies past the bound (a very long first
 * line) is loaded whole, as `SessionManager.open` loads it, so such a session still opens where its header says
 * instead of in the host's folder (senpi#6427).
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
		const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
		let scanned = 0;
		while (scanned < SCAN_LIMIT_BYTES) {
			const length = Math.min(buffer.length, SCAN_LIMIT_BYTES - scanned);
			const { bytesRead } = await handle.read(buffer, 0, length, null);
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
	return headerCwdFromWholeFile(sessionFile);
}

/** The header of a file whose first entry lies past the scan bound: the whole file decides, as the manager does. */
async function headerCwdFromWholeFile(sessionFile: string): Promise<string | undefined> {
	for (const entry of await loadEntriesFromFileAsync(sessionFile)) {
		const found = candidate(JSON.stringify(entry));
		if (found) return found.cwd;
	}
	return undefined;
}
