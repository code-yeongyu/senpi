import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
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
 * owner: `{ "version": 1, "root": "<absolute path>" }`; an entry of any other version is ignored. The
 * root is laid out like `<agentDir>/sessions`: one level of directories, each holding `*.jsonl` session
 * files. Listings only read a store: their summary cache lives under
 * `<agentDir>/cache/session-store-summaries/`, never in the store. Nothing else is cached: each listing
 * reads the entries and the store directories again, so a session the app creates shows in the next
 * list of an already running process. A session opened from a store keeps this agent dir's own session
 * folder for listing and new sessions; only that session's file lives in the store.
 */
export const SHARED_SESSION_STORES_DIR_NAME = "session-stores";
const SHARED_SESSION_STORES_VERSION = 1;

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
		if (typeof entry !== "object" || entry === null || !("root" in entry) || !("version" in entry)) return undefined;
		if (entry.version !== SHARED_SESSION_STORES_VERSION) return undefined;
		const root = entry.root;
		return typeof root === "string" && isAbsolute(root) ? normalizePath(root) : undefined;
	} catch {
		// An unreadable or malformed entry registers nothing; it never fails a listing.
		return undefined;
	}
}

async function registeredRoots(agentDir: string): Promise<Set<string>> {
	const storesDir = getSharedSessionStoresDir(agentDir);
	const roots = new Set<string>();
	for (const entry of await readableEntries(storesDir)) {
		if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
		const root = await registeredRoot(join(storesDir, entry.name));
		if (root !== undefined) roots.add(root);
	}
	return roots;
}

export async function isSharedSessionStoreDir(dir: string, agentDir: string = getAgentDir()): Promise<boolean> {
	return (await registeredRoots(agentDir)).has(normalizePath(resolve(dir, "..")));
}

export async function sharedSessionStoreDirs(agentDir: string = getAgentDir()): Promise<string[]> {
	const dirs = new Set<string>();
	for (const root of await registeredRoots(agentDir)) {
		for (const entry of await readableEntries(root)) {
			if (entry.isDirectory()) dirs.add(join(root, entry.name));
		}
	}
	return [...dirs];
}

export function sharedStoreSummaryDir(dir: string, agentDir: string = getAgentDir()): string {
	const key = createHash("sha256").update(normalizePath(dir)).digest("hex").slice(0, 32);
	return join(agentDir, "cache", "session-store-summaries", key);
}

export async function listSharedStoreSessions(
	include: (session: SessionInfo) => boolean,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	for (const dir of await sharedSessionStoreDirs()) {
		const listed = await listSessionsFromDir(dir, undefined, signal, sharedStoreSummaryDir(dir));
		sessions.push(...listed.filter(include));
	}
	return sessions;
}
