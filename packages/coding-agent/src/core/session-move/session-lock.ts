import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { withSessionMoveLock as withHolderMoveLock } from "../session-holders.ts";
import { loadEntriesFromFileAsync } from "../session-manager.ts";
import { serializeByKey } from "../session-sidecar-store.ts";
import { headerSessionId } from "./ownership.ts";

export async function realSessionPath(path: string): Promise<string> {
	const absolute = resolve(path);
	try {
		return await realpath(absolute);
	} catch {
		return absolute;
	}
}

const lockKey = (resolvedPath: string): string => `session-move:${resolvedPath}`;

// Resolutions of one path settle one after another, in call order, so two steps asked for in order enter the
// per-file queue in that order even though resolving the real path is asynchronous. Each path has its own chain, so
// one stuck realpath never delays another file's; a chain is dropped once it is idle. `realSessionPath` never rejects.
const pathChains = new Map<string, Promise<string>>();

export function orderedRealPath(path: string): Promise<string> {
	const key = resolve(path);
	const next = (pathChains.get(key) ?? Promise.resolve("")).then(() => realSessionPath(path));
	pathChains.set(key, next);
	void next.then(() => {
		if (pathChains.get(key) === next) pathChains.delete(key);
	});
	return next;
}

export const moveLockKey = async (sessionFile: string): Promise<string> => lockKey(await orderedRealPath(sessionFile));

/**
 * Runs the sender's steps of a move (export, finish) one at a time per session file, across processes too.
 *
 * - In this process, steps queue per file, so a second `finish` for the same move starts after the first has settled
 *   and finds the move already closed: the queued input it hands back is re-queued once, never twice.
 * - Across processes (two host generations on one agent directory), the step holds the session's move lock, which
 *   proves no live process holds the session (`SessionHeldError`, code `ESESSIONHELD`) and makes every later
 *   `holdSessionFile` wait or refuse while the step runs.
 * - `guard` runs first inside the queue, so a caller's own check (for example "not open on this host") sees the
 *   state the step will act on.
 */
export async function withSessionMoveLock<T>(
	sessionFile: string,
	step: () => Promise<T>,
	guard?: () => void | Promise<void>,
): Promise<T> {
	const path = await orderedRealPath(sessionFile);
	return serializeByKey(lockKey(path), async () => {
		await guard?.();
		const sessionId = headerSessionId(await loadEntriesFromFileAsync(path));
		return sessionId === undefined ? step() : withHolderMoveLock(path, sessionId, step);
	});
}
