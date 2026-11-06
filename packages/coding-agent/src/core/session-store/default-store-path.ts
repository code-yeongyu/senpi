import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

// Where a session's default durable store lives. No SQLite here: the session delete path runs on Node too.

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The session directory as the filesystem names it (symlinks resolved, stored case), or as given once it is gone. */
function realSessionDir(sessionDir: string): string {
	try {
		return realpathSync.native(sessionDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return resolve(sessionDir);
	}
}

/**
 * `<agentDir>/session-store/<session dir hash>/<sessionId>`: a session id is unique only within its directory (one per
 * project), so two projects using the same id never share a medium.
 */
export function defaultSessionStoreMedium(agentDir: string, sessionDir: string, sessionId: string): string {
	if (!SESSION_ID.test(sessionId)) throw new Error(`not a session id: ${JSON.stringify(sessionId)}`);
	const scope = createHash("sha256").update(realSessionDir(sessionDir)).digest("hex").slice(0, 16);
	return join(agentDir, "session-store", scope, sessionId);
}
