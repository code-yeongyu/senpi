import { cp, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
import { getDefaultSessionDir, loadEntriesFromFileAsync } from "./session-manager.ts";
import { encodedSessionId } from "./session-sidecar-store.ts";
import { pathExists } from "./tools/path-utils.ts";

interface SessionHeaderLine {
	readonly header: { readonly type: "session"; readonly id: string; readonly cwd?: unknown };
	readonly rest: string;
}

export async function readRecordedRepositoryIdentity(sessionFile: string): Promise<RepositoryIdentity | undefined> {
	let recorded: RepositoryIdentity | undefined;
	for (const entry of await loadEntriesFromFileAsync(sessionFile)) {
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
		pathExists(sessionCwd).then((exists) => (exists ? read(sessionCwd) : undefined)),
	]);
	return compareRepositoryIdentities(live ?? (await readRecordedRepositoryIdentity(sessionFile)), current);
}

export async function readSessionCwd(sessionFile: string): Promise<string | undefined> {
	const { cwd } = await readHeader(resolvePath(sessionFile));
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
	if (target !== source && (await movedAlready(source, target))) return target;
	const header = await readHeaderBeforeLock(source, target);
	if (header === undefined) return target;
	return withSessionMoveLock(source, header.id, () => moveSessionFile(source, target, cwd), {
		...(options.moveLockWaitMs === undefined ? {} : { waitMs: options.moveLockWaitMs }),
	});
}

// The lock is keyed by the session id, so the header is read before the lock is held. A concurrent rebind can finish
// the move between the existence check and this read; the mover writes the target before it removes the source, so a
// missing source next to an existing target means the move is already done (`undefined`).
async function readHeaderBeforeLock(source: string, target: string): Promise<SessionHeaderLine["header"] | undefined> {
	try {
		return await readHeader(source);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" && target !== source && (await pathExists(target)))
			return undefined;
		throw error;
	}
}

async function moveSessionFile(source: string, target: string, cwd: string): Promise<string> {
	if (target !== source && (await movedAlready(source, target))) return target;
	const { header, rest } = await readHeaderLine(source);
	if (target !== source && (await pathExists(target))) {
		throw new Error(`Cannot rebind session: ${target} already exists`);
	}
	const targetDir = dirname(target);
	await mkdir(targetDir, { recursive: true });
	const temp = join(targetDir, `.${basename(source)}.rebind-${process.pid}.tmp`);
	await writeFile(temp, `${JSON.stringify({ ...header, cwd })}\n${rest}`, { flag: "wx" });
	if (target !== source) await moveSessionSidecars(dirname(source), targetDir, header.id);
	await rename(temp, target);
	if (target !== source) await rm(source, { force: true });
	return target;
}

/** A concurrent rebind writes the target before it removes the source: no source next to a target means done. */
async function movedAlready(source: string, target: string): Promise<boolean> {
	return !(await pathExists(source)) && (await pathExists(target));
}

async function readHeaderLine(sessionFile: string): Promise<SessionHeaderLine> {
	const content = await readFile(sessionFile, "utf8");
	const newline = content.indexOf("\n");
	const firstLine = newline === -1 ? content : content.slice(0, newline);
	return { header: parseHeader(firstLine, sessionFile), rest: newline === -1 ? "" : content.slice(newline + 1) };
}

const HEADER_CHUNK_BYTES = 64 * 1024;

/** The header alone: reads up to the first newline, never the transcript after it. */
async function readHeader(sessionFile: string): Promise<SessionHeaderLine["header"]> {
	const handle = await open(sessionFile, "r");
	try {
		const chunks: Buffer[] = [];
		const buffer = Buffer.allocUnsafe(HEADER_CHUNK_BYTES);
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;
			const chunk = buffer.subarray(0, bytesRead);
			const newline = chunk.indexOf(0x0a);
			chunks.push(Buffer.from(newline === -1 ? chunk : chunk.subarray(0, newline)));
			if (newline !== -1) break;
		}
		return parseHeader(Buffer.concat(chunks).toString("utf8"), sessionFile);
	} finally {
		await handle.close();
	}
}

function parseHeader(firstLine: string, sessionFile: string): SessionHeaderLine["header"] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(firstLine);
	} catch {
		parsed = undefined;
	}
	if (!isSessionHeader(parsed)) {
		throw new Error(`Cannot rebind session: ${sessionFile} does not start with a session header`);
	}
	return parsed;
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
async function moveSessionSidecars(fromDir: string, toDir: string, sessionId: string): Promise<void> {
	const extensionsDir = join(fromDir, "extensions");
	const sidecarName = `${encodedSessionId(sessionId)}.json`;
	if (await pathExists(extensionsDir)) {
		for (const extension of await readdir(extensionsDir, { withFileTypes: true })) {
			if (!extension.isDirectory()) continue;
			const from = join(extensionsDir, extension.name, sidecarName);
			if (await pathExists(from)) await movePath(from, join(toDir, "extensions", extension.name, sidecarName));
		}
	}
	const blobs = join(fromDir, "resident-blobs", sessionId);
	if (await pathExists(blobs)) await movePath(blobs, join(toDir, "resident-blobs", sessionId));
}

async function movePath(from: string, to: string): Promise<void> {
	if (await pathExists(to)) return;
	await mkdir(dirname(to), { recursive: true });
	try {
		await rename(from, to);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		await cp(from, to, { recursive: true });
		await rm(from, { recursive: true, force: true });
	}
}
