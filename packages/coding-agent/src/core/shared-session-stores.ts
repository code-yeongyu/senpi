import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import { listSessionsFromDir } from "./session-discovery.ts";
import type { SessionInfo } from "./session-manager.ts";

/**
 * Shared session index (omo-desktop-app#8097). Another app on this machine that keeps its sessions in
 * its own store (the OmO desktop keeps them under its state dir) registers that store here, so every
 * session list of this agent dir shows its sessions too.
 *
 * Layout: `<agentDir>/session-stores/<name>.json`, one file per store, written only by the store's
 * owner: `{ "version": 1, "root": "<absolute path>" }`. The root is laid out like
 * `<agentDir>/sessions`: one level of directories, each holding `*.jsonl` session files. Nothing is
 * cached: each listing reads the entries and the store directories again, so a session the app creates
 * shows in the next list of an already running process.
 */
export const SHARED_SESSION_STORES_DIR_NAME = "session-stores";

export function getSharedSessionStoresDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, SHARED_SESSION_STORES_DIR_NAME);
}

async function readableEntries(dir: string): Promise<Dirent[]> {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

async function registeredRoot(file: string): Promise<string | undefined> {
	try {
		const entry: unknown = JSON.parse(await readFile(file, "utf8"));
		if (typeof entry !== "object" || entry === null || !("root" in entry)) return undefined;
		const root = entry.root;
		return typeof root === "string" && isAbsolute(root) ? normalizePath(root) : undefined;
	} catch {
		// An unreadable or malformed entry registers nothing; it never fails a listing.
		return undefined;
	}
}

export async function sharedSessionStoreDirs(agentDir: string = getAgentDir()): Promise<string[]> {
	const storesDir = getSharedSessionStoresDir(agentDir);
	const roots = new Set<string>();
	for (const entry of await readableEntries(storesDir)) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const root = await registeredRoot(join(storesDir, entry.name));
		if (root !== undefined) roots.add(root);
	}
	const dirs = new Set<string>();
	for (const root of roots) {
		for (const entry of await readableEntries(root)) {
			if (entry.isDirectory()) dirs.add(join(root, entry.name));
		}
	}
	return [...dirs];
}

export async function listSharedStoreSessions(
	include: (session: SessionInfo) => boolean,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	for (const dir of await sharedSessionStoreDirs()) {
		sessions.push(...(await listSessionsFromDir(dir, undefined, signal)).filter(include));
	}
	return sessions;
}
