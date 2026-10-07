import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { compareRepositoryIdentities, type RepositoryIdentity, readRepositoryIdentity } from "./repository-identity.ts";
import { listSessionsFromDir } from "./session-discovery.ts";
import { getDefaultSessionDir, type SessionInfo } from "./session-manager.ts";
import { readFileLines } from "./session-summary.ts";

// A session is "moved" when it belongs to the current repository (by its recorded identity) and was
// recorded at a path that no longer exists: the repository moved away from it. A live second checkout
// is not moved, and an unrecorded or different repository never matches.

export interface MovedSessionOptions {
	readonly sessionDir?: string;
	readonly readIdentity?: (dir: string) => Promise<RepositoryIdentity | undefined>;
}

function isMoved(session: SessionInfo, cwd: string, current: RepositoryIdentity): boolean {
	if (!session.cwd || resolvePath(session.cwd) === cwd || existsSync(session.cwd)) return false;
	return compareRepositoryIdentities(session.repositoryIdentity, current) === "same";
}

function newestFirst(a: SessionInfo, b: SessionInfo): number {
	return b.modified.getTime() - a.modified.getTime();
}

async function recordedCwd(dir: string): Promise<string | undefined> {
	const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
	for (const name of names) {
		let firstLine: string | undefined;
		try {
			await readFileLines(join(dir, name), (line) => {
				firstLine = line;
				return false;
			});
			const header: unknown = JSON.parse(firstLine ?? "");
			if (typeof header === "object" && header !== null && "cwd" in header && typeof header.cwd === "string") {
				return header.cwd;
			}
		} catch (error) {
			if (!(error instanceof Error)) throw error;
		}
	}
	return undefined;
}

// Each project directory holds one cwd, so one header decides whether its sessions can be moved ones;
// only directories whose recorded path is gone are listed in full.
async function sessionsAtVanishedPaths(cwd: string): Promise<SessionInfo[]> {
	const root = getSessionsDir();
	if (!existsSync(root)) return [];
	const own = normalizePath(getDefaultSessionDir(cwd));
	const sessions: SessionInfo[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		if (normalizePath(dir) === own) continue;
		const recorded = await recordedCwd(dir);
		if (recorded === undefined || existsSync(recorded)) continue;
		sessions.push(...(await listSessionsFromDir(dir)));
	}
	return sessions;
}

export async function listMovedSessions(cwd: string, options: MovedSessionOptions = {}): Promise<SessionInfo[]> {
	const here = resolvePath(cwd);
	const current = await (options.readIdentity ?? readRepositoryIdentity)(here);
	if (current === undefined) return [];
	const candidates = options.sessionDir
		? await listSessionsFromDir(normalizePath(options.sessionDir))
		: await sessionsAtVanishedPaths(here);
	return candidates
		.filter((session) => isMoved(session, here, current))
		.map((session) => ({ ...session, moved: true }))
		.sort(newestFirst);
}

export async function markMovedSessions(
	sessions: readonly SessionInfo[],
	cwd: string,
	options: Pick<MovedSessionOptions, "readIdentity"> = {},
): Promise<SessionInfo[]> {
	const here = resolvePath(cwd);
	const current = await (options.readIdentity ?? readRepositoryIdentity)(here);
	if (current === undefined) return [...sessions];
	return sessions.map((session) => (isMoved(session, here, current) ? { ...session, moved: true } : session));
}

export async function withMovedSessions(
	local: Promise<SessionInfo[]>,
	cwd: string,
	options: MovedSessionOptions = {},
): Promise<SessionInfo[]> {
	const [own, moved] = await Promise.all([local, listMovedSessions(cwd, options)]);
	return [...own, ...moved].sort(newestFirst);
}
