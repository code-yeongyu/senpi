import { type Dirent, existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { sessionCwdMatcher } from "./moved-session-cwd.ts";
import { compareRepositoryIdentities, type RepositoryIdentity, readRepositoryIdentity } from "./repository-identity.ts";
import { listSessionsFromDir } from "./session-discovery.ts";
import { findMostRecentSession, getDefaultSessionDir, type SessionInfo } from "./session-manager.ts";
import { readFileLines } from "./session-summary.ts";

// A session is "moved" when it belongs to the current repository (by its recorded identity) and was
// recorded at a path that no longer exists: the repository moved away from it. A live second checkout
// is not moved, and an unrecorded or different repository never matches.

export interface MovedSessionOptions {
	readonly sessionDir?: string;
	readonly readIdentity?: (dir: string) => Promise<RepositoryIdentity | undefined>;
}

// A session recorded at a vanished path is "here" when the OmO desktop moved that path to `cwd`: it is this folder's
// own session, listed without the moved badge and never rebound (senpi#2990). A trusted breadcrumb decides that, so
// it needs no git identity; only a "moved" session (senpi#2184) is matched by the folder's identity.
type VanishedKind = "here" | "moved";

function vanishedClassifier(cwd: string, current: RepositoryIdentity | undefined) {
	const ownCwd = sessionCwdMatcher(cwd);
	const kind = (session: SessionInfo): VanishedKind | undefined => {
		if (!session.cwd || resolvePath(session.cwd) === cwd || existsSync(session.cwd)) return undefined;
		if (ownCwd(session.cwd)) return "here";
		if (current === undefined) return undefined;
		return compareRepositoryIdentities(session.repositoryIdentity, current) === "same" ? "moved" : undefined;
	};
	return { ownCwd, kind };
}

function newestFirst(a: SessionInfo, b: SessionInfo): number {
	return b.modified.getTime() - a.modified.getTime();
}

// A session dir that cannot be read contributes nothing; it never fails a listing or --continue (senpi#2990
// review L4). Every error is skipped, as findMostRecentSession and listSessionsFromDir already do: --continue
// reads other folders' dirs before its own, so one broken unrelated dir must not block the user's own session.
async function readableEntries(dir: string): Promise<Dirent[]> {
	try {
		return await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
}

async function recordedCwd(dir: string): Promise<string | undefined> {
	const names = (await readableEntries(dir)).map((entry) => entry.name).filter((name) => name.endsWith(".jsonl"));
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

// Each project directory holds one cwd, so one header decides whether its sessions can be moved ones; only
// directories whose recorded path is gone and that `keep` accepts are listed in full.
async function sessionsAtVanishedPaths(cwd: string, keep: (recorded: string) => boolean): Promise<SessionInfo[]> {
	const root = getSessionsDir();
	if (!existsSync(root)) return [];
	const own = normalizePath(getDefaultSessionDir(cwd));
	const sessions: SessionInfo[] = [];
	for (const entry of await readableEntries(root)) {
		if (!entry.isDirectory()) continue;
		const dir = join(root, entry.name);
		if (normalizePath(dir) === own) continue;
		const recorded = await recordedCwd(dir);
		if (recorded === undefined || existsSync(recorded) || !keep(recorded)) continue;
		sessions.push(...(await listSessionsFromDir(dir)));
	}
	return sessions;
}

/** Sessions at vanished paths of the `wanted` kinds, newest first; the identity is read only when "moved" is wanted. */
async function vanishedSessions(
	cwd: string,
	options: MovedSessionOptions,
	wanted: readonly VanishedKind[],
): Promise<Record<VanishedKind, SessionInfo[]>> {
	const found: Record<VanishedKind, SessionInfo[]> = { here: [], moved: [] };
	const here = resolvePath(cwd);
	const wantHere = wanted.includes("here");
	const current = wanted.includes("moved") ? await (options.readIdentity ?? readRepositoryIdentity)(here) : undefined;
	if (!wantHere && current === undefined) return found;
	const { ownCwd, kind } = vanishedClassifier(here, current);
	const candidates = options.sessionDir
		? await listSessionsFromDir(normalizePath(options.sessionDir))
		: await sessionsAtVanishedPaths(here, (recorded) => current !== undefined || ownCwd(recorded));
	for (const session of candidates) {
		const sessionKind = kind(session);
		if (sessionKind === "moved") found.moved.push({ ...session, moved: true });
		else if (sessionKind === "here" && wantHere) found.here.push(session);
	}
	found.here.sort(newestFirst);
	found.moved.sort(newestFirst);
	return found;
}

export async function listMovedSessions(cwd: string, options: MovedSessionOptions = {}): Promise<SessionInfo[]> {
	return (await vanishedSessions(cwd, options, ["moved"])).moved;
}

// findMostRecentSession's basis; a file that vanished since it was listed counts as oldest.
function mtimeMs(path: string): number {
	return statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
}

/**
 * `--continue` in the default per-folder layout (senpi#2990): the newest session the OmO desktop moved to `cwd` when it
 * is newer than the folder's own newest, else undefined. It lists only the dirs whose recorded path moved here and
 * reads no git identity, so a folder with its own session pays one header read per project dir.
 */
export async function movedHereSessionToContinue(cwd: string): Promise<string | undefined> {
	const { here } = await vanishedSessions(cwd, {}, ["here"]);
	const newest = here
		.map((session) => session.path)
		.reduce<string | undefined>(
			(best, path) => (best === undefined || mtimeMs(path) > mtimeMs(best) ? path : best),
			undefined,
		);
	if (newest === undefined) return undefined;
	const own = findMostRecentSession(getDefaultSessionDir(cwd));
	return own === null || mtimeMs(newest) > mtimeMs(own) ? newest : undefined;
}

export async function markMovedSessions(
	sessions: readonly SessionInfo[],
	cwd: string,
	options: Pick<MovedSessionOptions, "readIdentity"> = {},
): Promise<SessionInfo[]> {
	const here = resolvePath(cwd);
	const current = await (options.readIdentity ?? readRepositoryIdentity)(here);
	if (current === undefined) return [...sessions];
	const { kind } = vanishedClassifier(here, current);
	return sessions.map((session) => (kind(session) === "moved" ? { ...session, moved: true } : session));
}

export async function withMovedSessions(
	local: Promise<SessionInfo[]>,
	cwd: string,
	options: MovedSessionOptions = {},
): Promise<SessionInfo[]> {
	// A shared session dir's own listing already holds the sessions the desktop moved here, so only the default
	// per-folder layout looks for them elsewhere.
	const wanted: readonly VanishedKind[] = options.sessionDir ? ["moved"] : ["here", "moved"];
	const [own, vanished] = await Promise.all([local, vanishedSessions(cwd, options, wanted)]);
	// Defensive dedupe: a session listed by both lookups stays one row, the folder's own.
	const listed = new Set(own.map((session) => session.path));
	const extra = [...vanished.here, ...vanished.moved].filter((session) => !listed.has(session.path));
	return [...own, ...extra].sort(newestFirst);
}
