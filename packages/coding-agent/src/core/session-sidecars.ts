/**
 * A session's sidecars in its session folder: one state file per extension
 * (`extensions/<extension>/<session id>.json`) and its resident blobs (`resident-blobs/<session id>`). They are named
 * by the session id, not by the session file, so they outlive a file that is deleted, and a session of the same id
 * that lands in the folder later (a move back) is given them as its own.
 */
import { access, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { assertValidSessionId } from "./session-manager.ts";
import { encodedSessionId } from "./session-sidecar-store.ts";

async function directoriesIn(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir, { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch (error) {
		if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return [];
		throw error;
	}
}

const exists = (path: string): Promise<boolean> =>
	access(path).then(
		() => true,
		() => false,
	);

/**
 * The ones that are there, and nothing of another session. The id is read from a file's header by the caller, so an
 * id that could name another folder is refused before anything is looked at.
 */
export async function sessionSidecars(sessionDir: string, sessionId: string): Promise<string[]> {
	assertValidSessionId(sessionId);
	const extensions = join(sessionDir, "extensions");
	const stateFile = `${encodedSessionId(sessionId)}.json`;
	const candidates = [
		...(await directoriesIn(extensions)).map((extension) => join(extensions, extension, stateFile)),
		join(sessionDir, "resident-blobs", sessionId),
	];
	const there = await Promise.all(candidates.map(exists));
	return candidates.filter((_path, index) => there[index]);
}

export async function removeSessionSidecars(sessionDir: string, sessionId: string): Promise<void> {
	for (const path of await sessionSidecars(sessionDir, sessionId)) await rm(path, { recursive: true, force: true });
}
