import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolveMovedPath } from "./extensions/builtin/moved-path-guard/resolve.ts";
import { errorCode, type LockProbes } from "./extensions/builtin/terminal/lease-file.ts";
import { liveSessionHolders, type SessionHolder } from "./session-holders.ts";
import { parseEntryLine } from "./session-record.ts";

/** Read only the header, asynchronously: checking admission must not load or mutate a transcript. */
async function sessionIdFromFile(sessionFile: string): Promise<string | undefined> {
	try {
		// Admission must not consume a pipe: its reader belongs to the session runtime.
		if (!(await stat(sessionFile)).isFile()) return undefined;
		const stream = createReadStream(sessionFile, { encoding: "utf8" });
		const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
		try {
			for await (const line of lines) {
				const entry = parseEntryLine(line);
				if (entry === null) continue;
				return entry.type === "session" && typeof entry.id === "string" ? entry.id : undefined;
			}
			return undefined;
		} finally {
			lines.close();
			stream.destroy();
		}
	} catch (cause) {
		// A path that does not yet exist is a new session, not a held resume.
		if (errorCode(cause) === "ENOENT") return undefined;
		throw cause;
	}
}

/** Fresh lease evidence for each admission; a clean exit or stale identity clears the next retry. */
export async function foreignSessionHolders(
	sessionFile: string | undefined,
	sessionId?: string,
	probes?: LockProbes,
): Promise<SessionHolder[]> {
	if (sessionFile === undefined) return [];
	const path = resolveMovedPath(sessionFile);
	const id = sessionId ?? (await sessionIdFromFile(path));
	if (id === undefined) return [];
	// Both runtimes currently use this PID: the session-worker is a worker_threads Worker,
	// not a subprocess. Do not exclude arbitrary descendants or holder-supplied host identities.
	return (await liveSessionHolders(path, id, probes)).filter((holder) => holder.pid !== process.pid);
}

/** One terminal-safe line; cwd can contain newlines or escape sequences. */
export async function sessionHolderWarning(
	sessionFile: string | undefined,
	sessionId?: string,
): Promise<string | undefined> {
	let holders: SessionHolder[];
	try {
		holders = await foreignSessionHolders(sessionFile, sessionId);
	} catch {
		return "Unable to inspect session holders; continuing without holder information.";
	}
	if (holders.length === 0) return undefined;
	const who = holders.map(({ pid, cwd }) => `pid ${pid}${cwd === undefined ? "" : ` in ${JSON.stringify(cwd)}`}`);
	return `This session is also open in another process (${who.join("; ")}). Concurrent writes may corrupt its history; quit the other process before continuing.`;
}
