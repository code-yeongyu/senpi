import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, relative, sep } from "node:path";
import { SessionHeldError } from "../session-hold-errors.ts";
import { liveSessionHolders } from "../session-holders.ts";
import { loadEntriesFromFileAsync, SessionManager } from "../session-manager.ts";
import { readRecordedRepositoryIdentity, readSessionCwd } from "../session-rebind.ts";
import { encodedSessionId } from "../session-sidecar-store.ts";
import { pathExists } from "../tools/path-utils.ts";
import {
	type BundleFile,
	MANIFEST_FILE,
	MOVE_BUNDLE_FORMAT,
	type MoveManifest,
	parseMoveId,
	parsePlainId,
	SESSION_BUNDLE_PATH,
	sha256File,
} from "./bundle.ts";
import { EXTENSION_STATE_PAYLOAD } from "./extension-state.ts";
import {
	headerSessionId,
	type MoveId,
	SESSION_RELEASED,
	SessionMovedAwayError,
	sessionOwnership,
} from "./ownership.ts";
import { withSessionMoveLock } from "./session-lock.ts";

export interface ExportSessionForMoveOptions {
	/** A session no live runtime holds: an RPC host releases it first (`release_session` reason `move`). */
	readonly sessionFile: string;
	readonly moveId: MoveId;
	readonly target: string;
	/**
	 * Queued user input the release took out of the session (`dropped.user_messages`), in order. Omitted keeps what a
	 * kept bundle of this move already records, so a caller that lost the release's answer does not erase it by
	 * exporting again (senpi#6267).
	 */
	readonly droppedUserMessages?: readonly string[];
	readonly bundleDir: string;
	/**
	 * What the extensions wrote at the move release, bundled as the `extension-state` payload. A function is resolved
	 * inside the move lock, right before the bundle is written (`sealedOutgoingStateDir`: the sealing attempt's folder).
	 */
	readonly extensionStateDir?: string | (() => string | undefined | Promise<string | undefined>);
	/** Runs inside this process's move queue before anything is read; throw to refuse. */
	readonly guard?: () => void | Promise<void>;
	/**
	 * Runs inside the cross-process move lock, right before the session is read and sealed; throw to refuse. A check on
	 * the session file's state belongs here: another generation can change it between `guard` and the lock.
	 */
	readonly lockedGuard?: () => void | Promise<void>;
}

/**
 * Seals the session for the move (a `session_released` entry with reason `move`; from then on this device refuses
 * writes) and writes a self-verifying bundle: the session file, its extension sidecars and resident blobs, and a
 * manifest. Running it again for the same move rewrites the same bundle without a second release entry.
 */
export function exportSessionForMove(options: ExportSessionForMoveOptions): Promise<MoveManifest> {
	return exportSessionForMoveAndRead(options, async () => undefined).then(({ manifest }) => manifest);
}

/**
 * `exportSessionForMove`, then `read` on the written bundle folder before the move lock is released, so a `finish` or
 * a second export of the session cannot change the folder while it is read (senpi#6267: the inline answer).
 */
export function exportSessionForMoveAndRead<T>(
	options: ExportSessionForMoveOptions,
	read: (bundleDir: string) => Promise<T>,
): Promise<{ readonly manifest: MoveManifest; readonly read: T }> {
	return withSessionMoveLock(
		options.sessionFile,
		async () => {
			await options.lockedGuard?.();
			const manifest = await writeMoveBundle(options);
			return { manifest, read: await read(options.bundleDir) };
		},
		options.guard,
	);
}

/** The release that sealed the session staged extension state that is no longer on disk; bundling would lose it. */
export class MovedStateMissingError extends Error {
	constructor(dir: string) {
		super(
			`The extension state the move release staged is missing (${dir}); the session was not exported without it. Finish the move as declined to take the session back, then release it again.`,
		);
		this.name = "MovedStateMissingError";
	}
}

async function writeMoveBundle(options: ExportSessionForMoveOptions): Promise<MoveManifest> {
	const { sessionFile } = options;
	const moveId = parseMoveId(options.moveId);
	const entries = await loadEntriesFromFileAsync(sessionFile);
	// The id names the resident-blob folder copied below and must be one the receiver accepts: check it before sealing.
	const sessionId = parsePlainId(headerSessionId(entries), "session id");
	// A live runtime could still write the transcript, its sidecars or its resident blobs after the seal.
	const holders = await liveSessionHolders(sessionFile, sessionId);
	if (holders.length > 0) throw new SessionHeldError(sessionFile, holders);
	const ownership = sessionOwnership(entries);
	if (!ownership.writable && !(ownership.state === "moving" && ownership.moveId === moveId)) {
		throw new SessionMovedAwayError(sessionFile, ownership);
	}
	// Before the seal and before anything is staged: a kept bundle that cannot be read refuses the export unchanged.
	const dropped = options.droppedUserMessages ?? (await keptDroppedUserMessages(options.bundleDir, moveId));
	if (ownership.writable) {
		(await SessionManager.openAsync(sessionFile)).appendCustomEntry(SESSION_RELEASED, {
			reason: "move",
			move_id: moveId,
			session_id: sessionId,
			target: options.target,
			released_at: new Date().toISOString(),
		});
	}
	const stateDir =
		typeof options.extensionStateDir === "function" ? await options.extensionStateDir() : options.extensionStateDir;
	if (stateDir !== undefined && !(await pathExists(stateDir))) throw new MovedStateMissingError(stateDir);
	const staging = `${options.bundleDir}.partial-${process.pid}`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(join(staging, dirname(SESSION_BUNDLE_PATH)), { recursive: true });
	await copyFile(sessionFile, join(staging, SESSION_BUNDLE_PATH));
	const sidecars = await copySidecars(dirname(sessionFile), sessionId, staging);
	const stateFiles = await copyExtensionState(stateDir, staging);
	const manifest: MoveManifest = {
		format: MOVE_BUNDLE_FORMAT,
		moveId,
		sessionId,
		sessionFileName: basename(sessionFile),
		sourceCwd: (await readSessionCwd(sessionFile)) ?? "",
		repository: await readRecordedRepositoryIdentity(sessionFile),
		session: { path: SESSION_BUNDLE_PATH, sha256: await sha256File(join(staging, SESSION_BUNDLE_PATH)) },
		sidecars,
		droppedUserMessages: [...dropped],
		payloads: stateFiles.length > 0 ? [{ kind: EXTENSION_STATE_PAYLOAD, files: stateFiles }] : [],
	};
	await writeFile(join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 1)}\n`);
	await rm(options.bundleDir, { recursive: true, force: true });
	await rename(staging, options.bundleDir);
	return manifest;
}

class KeptBundleUnreadableError extends Error {
	constructor(bundleDir: string, why: string) {
		super(
			`The bundle kept for this move (${bundleDir}) could not be read (${why}), so the move was not exported again: the new bundle would replace it and lose the queued input it records. Nothing was changed.`,
		);
		this.name = "KeptBundleUnreadableError";
	}
}

/**
 * The queued input the bundle already at this move's place records, when an export is sent again without a list.
 * Read leniently, by its format, move id and input alone: an export that failed after the seal keeps no more than
 * that, and the receiver's parser (`readManifest`) would refuse it. Only a bundle that is not there reads as no input.
 * One that is there and cannot be read or understood refuses the export, because the bundle that replaces it would
 * erase what it records. Another move's bundle records none of this move's input.
 */
async function keptDroppedUserMessages(bundleDir: string, moveId: MoveId): Promise<readonly string[]> {
	let text: string;
	try {
		text = await readFile(join(bundleDir, MANIFEST_FILE), "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw new KeptBundleUnreadableError(bundleDir, error instanceof Error ? error.message : String(error));
	}
	let kept: unknown;
	try {
		kept = JSON.parse(text);
	} catch {
		throw new KeptBundleUnreadableError(bundleDir, "its manifest is not JSON");
	}
	if (typeof kept !== "object" || kept === null || !("format" in kept) || kept.format !== MOVE_BUNDLE_FORMAT)
		throw new KeptBundleUnreadableError(bundleDir, "its manifest is not one this version writes");
	if (!("moveId" in kept) || kept.moveId !== moveId) return [];
	const input = "droppedUserMessages" in kept ? kept.droppedUserMessages : undefined;
	if (!Array.isArray(input) || !input.every((message): message is string => typeof message === "string"))
		throw new KeptBundleUnreadableError(bundleDir, "its manifest does not list its queued input");
	return input;
}

async function copySidecars(sessionDir: string, sessionId: string, staging: string): Promise<BundleFile[]> {
	const sources: string[] = [];
	const extensions = join(sessionDir, "extensions");
	const sidecarName = `${encodedSessionId(sessionId)}.json`;
	if (await pathExists(extensions)) {
		for (const extension of await readdir(extensions, { withFileTypes: true })) {
			const file = join(extensions, extension.name, sidecarName);
			if (extension.isDirectory() && (await pathExists(file))) sources.push(file);
		}
	}
	sources.push(...(await filesUnder(join(sessionDir, "resident-blobs", sessionId))));
	const files: BundleFile[] = [];
	for (const source of sources) {
		const path = bundlePath("files", sessionDir, source);
		await mkdir(dirname(join(staging, path)), { recursive: true });
		await copyFile(source, join(staging, path));
		files.push({ path, sha256: await sha256File(join(staging, path)) });
	}
	return files;
}

async function copyExtensionState(dir: string | undefined, staging: string): Promise<BundleFile[]> {
	if (dir === undefined) return [];
	const files: BundleFile[] = [];
	for (const source of await filesUnder(dir)) {
		const path = bundlePath("state", dir, source);
		await mkdir(dirname(join(staging, path)), { recursive: true });
		await copyFile(source, join(staging, path));
		files.push({ path, sha256: await sha256File(join(staging, path)) });
	}
	return files;
}

/** Manifest paths use `/` on every OS: the receiver strips the `files/` and `state/` prefixes by that separator. */
function bundlePath(prefix: string, from: string, source: string): string {
	return posix.join(prefix, ...relative(from, source).split(sep));
}

export async function filesUnder(dir: string): Promise<string[]> {
	if (!(await pathExists(dir))) return [];
	const files: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		files.push(...(entry.isDirectory() ? await filesUnder(path) : [path]));
	}
	return files;
}
