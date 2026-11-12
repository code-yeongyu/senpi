import { copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
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
	MovePathTooDeepError,
	nestsTooDeep,
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
	/** Queued user input the release took out of the session (`dropped.user_messages`), in order. */
	readonly droppedUserMessages: readonly string[];
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
	if (ownership.writable) {
		// Refused here, the session is not sealed for a move whose bundle a receiver would refuse (senpi#6469). That
		// covers a state folder given as a path. One given as a function is asked only after the seal, since it may
		// read what the seal wrote, so a refusal for it leaves the session sealed: with what is kept below, a declined
		// finish takes the session and its queued input back.
		const given = typeof options.extensionStateDir === "string" ? options.extensionStateDir : undefined;
		await assertMoveFits(sessionFile, sessionId, given, false);
		(await SessionManager.openAsync(sessionFile)).appendCustomEntry(SESSION_RELEASED, {
			reason: "move",
			move_id: moveId,
			session_id: sessionId,
			target: options.target,
			released_at: new Date().toISOString(),
		});
	}
	// From here the session is sealed for this move, and the input the release took out of it is in no file yet. It
	// is kept first, where the bundle will be, so that whatever stops this export a declined finish can put it back
	// (senpi#6542). The bundle takes its place below.
	await keepQueuedInput(options.bundleDir, moveId, options.droppedUserMessages);
	const stateDir =
		typeof options.extensionStateDir === "function" ? await options.extensionStateDir() : options.extensionStateDir;
	if (stateDir !== undefined && !(await pathExists(stateDir))) throw new MovedStateMissingError(stateDir);
	// A session sealed before anything looked (an earlier version's release) is refused before a bundle is written.
	await assertMoveFits(sessionFile, sessionId, stateDir, true);
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
		droppedUserMessages: [...options.droppedUserMessages],
		payloads: stateFiles.length > 0 ? [{ kind: EXTENSION_STATE_PAYLOAD, files: stateFiles }] : [],
	};
	await writeFile(join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 1)}\n`);
	await rm(options.bundleDir, { recursive: true, force: true });
	await rename(staging, options.bundleDir);
	return manifest;
}

/**
 * Keeps the input a release took out of a session, in the place its bundle will take: a manifest with the move and
 * that input and nothing else, which the sender's `finish` reads to put the input back. It is not a bundle, and a
 * receiver's reader refuses it. Nothing is written when there is no input, or when a bundle is already there: an
 * earlier export's bundle carries the input, and whoever sends it may be reading it.
 */
async function keepQueuedInput(bundleDir: string, moveId: string, queued: readonly string[]): Promise<void> {
	if (queued.length === 0 || (await pathExists(bundleDir))) return;
	const staging = `${bundleDir}.kept-${process.pid}`;
	await rm(staging, { recursive: true, force: true });
	await mkdir(staging, { recursive: true });
	const kept = { format: MOVE_BUNDLE_FORMAT, moveId, droppedUserMessages: [...queued] };
	await writeFile(join(staging, MANIFEST_FILE), `${JSON.stringify(kept, null, 1)}\n`);
	await rename(staging, bundleDir);
}

/**
 * Refuses a move one of whose files would sit in the bundle deeper than a bundle path may be (senpi#6469): the
 * session's resident blobs, and the extension state staged for the move. Whoever seals a session for a move asks
 * first, so a session a receiver would refuse is never sealed.
 */
export async function assertMoveFits(
	sessionFile: string,
	sessionId: string,
	stateDir: string | undefined,
	sealedAlready: boolean,
): Promise<void> {
	const sessionDir = dirname(sessionFile);
	const blobs = await filesUnder(join(sessionDir, "resident-blobs", sessionId));
	const paths = blobs.map((source) => bundlePath("files", sessionDir, source));
	if (stateDir !== undefined) {
		for (const source of await filesUnder(stateDir)) paths.push(bundlePath("state", stateDir, source));
	}
	const tooDeep = paths.find(nestsTooDeep);
	if (tooDeep !== undefined) throw new MovePathTooDeepError(tooDeep, sealedAlready);
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
