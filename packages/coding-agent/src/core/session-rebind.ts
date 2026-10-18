import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import {
	compareRepositoryIdentities,
	parseRepositoryIdentity,
	REPOSITORY_IDENTITY_ENTRY_TYPE,
	type RepositoryIdentity,
	type RepositoryMatch,
	readRepositoryIdentity,
} from "./repository-identity.ts";
import { withSessionMoveLock } from "./session-holders.ts";
import { getDefaultSessionDir, loadEntriesFromFile } from "./session-manager.ts";
import { encodedSessionId } from "./session-sidecar-store.ts";

interface SessionHeaderLine {
	readonly header: { readonly type: "session"; readonly id: string; readonly cwd?: unknown };
	readonly rest: string;
}

export function readRecordedRepositoryIdentity(sessionFile: string): RepositoryIdentity | undefined {
	let recorded: RepositoryIdentity | undefined;
	for (const entry of loadEntriesFromFile(sessionFile)) {
		if (entry.type === "custom" && entry.customType === REPOSITORY_IDENTITY_ENTRY_TYPE) {
			recorded = parseRepositoryIdentity(entry.data) ?? recorded;
		}
	}
	return recorded;
}

/**
 * Whether `cwd` is the git repository a session was recorded in. The session side prefers the live
 * checkout at its recorded cwd and falls back to the identity the session recorded, because a moved
 * repository leaves nothing at the old path to ask.
 */
export async function classifySessionRepository(
	sessionFile: string,
	sessionCwd: string,
	cwd: string,
	read: (dir: string) => Promise<RepositoryIdentity | undefined> = readRepositoryIdentity,
): Promise<RepositoryMatch> {
	const [current, live] = await Promise.all([
		read(cwd),
		existsSync(sessionCwd) ? read(sessionCwd) : Promise.resolve(undefined),
	]);
	return compareRepositoryIdentities(live ?? readRecordedRepositoryIdentity(sessionFile), current);
}

export function readSessionCwd(sessionFile: string): string | undefined {
	const { cwd } = readHeaderLine(resolvePath(sessionFile)).header;
	return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
}

/**
 * Moves a session recorded under another project into `targetCwd`'s session directory and points its
 * header at `targetCwd`. The id, file name, every entry after the header, and the session's extension
 * sidecars are kept. The relocated copy is complete before the source is removed, so an interrupted
 * rebind leaves the session readable in at least one place. Returns the session file's new path.
 *
 * The move runs under the session's cross-process move lock and refuses (`SessionHeldError`) while
 * another live process has the session open. A rebind that finds the same move already done by a
 * concurrent process returns that target.
 */
export async function rebindSessionFile(
	sourcePath: string,
	targetCwd: string,
	sessionDir?: string,
	options: { readonly moveLockWaitMs?: number } = {},
): Promise<string> {
	const source = resolvePath(sourcePath);
	const cwd = resolvePath(targetCwd);
	const targetDir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
	const target = join(targetDir, basename(source));
	if (target !== source && !existsSync(source) && existsSync(target)) return target;
	const header = readHeaderBeforeLock(source, target);
	if (header === undefined) return target;
	return withSessionMoveLock(source, header.id, () => moveSessionFile(source, target, cwd), {
		...(options.moveLockWaitMs === undefined ? {} : { waitMs: options.moveLockWaitMs }),
	});
}

// The lock is keyed by the session id, so the header is read before the lock is held. A concurrent rebind can finish
// the move between the existence check and this read; the mover writes the target before it removes the source, so a
// missing source next to an existing target means the move is already done (`undefined`).
function readHeaderBeforeLock(source: string, target: string): SessionHeaderLine["header"] | undefined {
	try {
		return readHeaderLine(source).header;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && target !== source && existsSync(target))
			return undefined;
		throw error;
	}
}

function moveSessionFile(source: string, target: string, cwd: string): string {
	if (target !== source && !existsSync(source) && existsSync(target)) return target;
	const { header, rest } = readHeaderLine(source);
	if (target !== source && existsSync(target)) {
		throw new Error(`Cannot rebind session: ${target} already exists`);
	}
	const targetDir = dirname(target);
	mkdirSync(targetDir, { recursive: true });
	const temp = join(targetDir, `.${basename(source)}.rebind-${process.pid}.tmp`);
	writeFileSync(temp, `${JSON.stringify({ ...header, cwd })}\n${rest}`, { flag: "wx" });
	if (target !== source) moveSessionSidecars(dirname(source), targetDir, header.id);
	renameSync(temp, target);
	if (target !== source) rmSync(source, { force: true });
	return target;
}

function readHeaderLine(sessionFile: string): SessionHeaderLine {
	const content = readFileSync(sessionFile, "utf8");
	const newline = content.indexOf("\n");
	const firstLine = newline === -1 ? content : content.slice(0, newline);
	let parsed: unknown;
	try {
		parsed = JSON.parse(firstLine);
	} catch {
		parsed = undefined;
	}
	if (!isSessionHeader(parsed)) {
		throw new Error(`Cannot rebind session: ${sessionFile} does not start with a session header`);
	}
	return { header: parsed, rest: newline === -1 ? "" : content.slice(newline + 1) };
}

function isSessionHeader(value: unknown): value is SessionHeaderLine["header"] {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { type?: unknown }).type === "session" &&
		typeof (value as { id?: unknown }).id === "string"
	);
}

// Per-session extension state lives at `<sessionDir>/extensions/<extension>/<encoded id>.json`
// (goal, loop, terminal monitors); without it a rebound session would lose its goal and monitors.
function moveSessionSidecars(fromDir: string, toDir: string, sessionId: string): void {
	const extensionsDir = join(fromDir, "extensions");
	const sidecarName = `${encodedSessionId(sessionId)}.json`;
	if (existsSync(extensionsDir)) {
		for (const extension of readdirSync(extensionsDir, { withFileTypes: true })) {
			if (!extension.isDirectory()) continue;
			const from = join(extensionsDir, extension.name, sidecarName);
			if (existsSync(from)) movePath(from, join(toDir, "extensions", extension.name, sidecarName));
		}
	}
	const blobs = join(fromDir, "resident-blobs", sessionId);
	if (existsSync(blobs)) movePath(blobs, join(toDir, "resident-blobs", sessionId));
}

function movePath(from: string, to: string): void {
	if (existsSync(to)) return;
	mkdirSync(dirname(to), { recursive: true });
	try {
		renameSync(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		cpSync(from, to, { recursive: true });
		rmSync(from, { recursive: true, force: true });
	}
}
