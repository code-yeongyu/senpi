/**
 * Copies a session file into a new session under a caller-chosen id (senpi#5889), so work can go on from a session
 * that is read-only here: one that moved away, or a copy sealed by `revoke`. The copy's header carries the new id, so the
 * ownership entries it inherits name the old session and no longer apply (`ownership.ts`): the copy is writable. The
 * source is only read.
 */
import { readdir } from "node:fs/promises";
import { loadEntriesFromFileAsync, type SessionHeader, SessionManager, sessionFileNameId } from "../session-manager.ts";
import { serializeByKey } from "../session-sidecar-store.ts";
import { headerSessionId } from "./ownership.ts";

export interface CopySessionOptions {
	readonly sourceFile: string;
	readonly sessionId: string;
	/** The copy's folder, given the source header's working directory. */
	readonly sessionDir: (cwd: string) => string;
}

class SessionCopyRefusal extends Error {
	readonly code: "move_target_occupied" | "invalid_move_request";

	constructor(code: SessionCopyRefusal["code"], detail: string) {
		super(detail);
		this.name = "SessionCopyRefusal";
		this.code = code;
	}
}

async function idTaken(dir: string, sessionId: string): Promise<boolean> {
	const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return [];
		throw error;
	});
	return names.some((name) => sessionFileNameId(name) === sessionId);
}

export async function copySessionAs(
	options: CopySessionOptions,
): Promise<{ readonly session_id: string; readonly session_path: string }> {
	const entries = await loadEntriesFromFileAsync(options.sourceFile);
	const cwd = entries.find((entry): entry is SessionHeader => entry.type === "session")?.cwd;
	if (!cwd) throw new Error(`The session at ${options.sourceFile} has no working directory in its header.`);
	if (headerSessionId(entries) === options.sessionId)
		throw new SessionCopyRefusal(
			"invalid_move_request",
			"The copy needs a new session id: under the source's own id it would stay read-only.",
		);
	const dir = options.sessionDir(cwd);
	return serializeByKey(`session-copy:${dir}:${options.sessionId}`, async () => {
		if (await idTaken(dir, options.sessionId))
			throw new SessionCopyRefusal(
				"move_target_occupied",
				`A session with id ${options.sessionId} already exists in ${dir}. Copy under another id.`,
			);
		const copy = SessionManager.forkFrom(options.sourceFile, cwd, dir, { id: options.sessionId });
		const sessionPath = copy.getSessionFile();
		if (sessionPath === undefined) throw new Error("The copy was created without a session file.");
		return { session_id: options.sessionId, session_path: sessionPath };
	});
}
