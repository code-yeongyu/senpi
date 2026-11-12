/**
 * Where one import attempt assembles the session it is about to land (senpi#4016): a folder of its own,
 * `<sessionDir>/.move-staging/<moveId>/attempt-<random>`. Staging runs outside the move's record lock, and imports of
 * one move overlap when a caller sends the import again while the first still runs. So an attempt writes, commits
 * from and removes only its own folder, and never reuses what another attempt staged: a retry stages again.
 */
import { access, copyFile, mkdir, mkdtemp, readdir, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SessionManager } from "../session-manager.ts";
import { EXTENSION_STATE_PREFIX, MoveBundleInvalidError, type MoveManifest, sha256File } from "./bundle.ts";
import { EXTENSION_STATE_PAYLOAD } from "./extension-state.ts";
import { type MoveId, SESSION_MOVED_IN } from "./ownership.ts";
import { requeueInput } from "./requeue.ts";

const STAGING_FOLDER = ".move-staging";
const ATTEMPT_PREFIX = "attempt-";
/** Staging not modified for this long was left by an import that died; an attempt in progress is younger. */
const STALE_STAGING_MS = 60 * 60_000;
/** Payload files are staged here, next to the staged session file, and placed from this checked copy. */
const STAGED_PAYLOADS = ".payloads";

export interface StagedBundle {
	readonly bundleDir: string;
	readonly manifest: MoveManifest;
	/** Where the bundle came from, recorded in the session's `session_moved_in` entry. */
	readonly from: string;
}

const failedWith = (error: unknown, ...codes: readonly string[]): boolean =>
	typeof error === "object" && error !== null && "code" in error && codes.some((code) => code === error.code);

/** A staging folder's entries; none when it is not there, which another attempt's cleanup can make true at any time. */
async function entriesOf(folder: string): Promise<string[]> {
	try {
		return (await readdir(folder)).map((name) => join(folder, name));
	} catch (error) {
		if (failedWith(error, "ENOENT", "ENOTDIR")) return [];
		throw error;
	}
}

/**
 * Staging is clutter once its attempt ended. A removal that fails leaves it for a later import's sweep and never
 * replaces what this import answers: a landed session answered as a failure sends the sender back for it.
 */
const discard = (path: string): Promise<void> => rm(path, { recursive: true, force: true }).catch(() => undefined);

const removeIfEmpty = (folder: string): Promise<void> => rmdir(folder).catch(() => undefined);

async function removeStaleStaging(root: string): Promise<void> {
	for (const moveFolder of await entriesOf(root)) {
		for (const entry of await entriesOf(moveFolder)) {
			const modified = await stat(entry).then(
				(found) => found.mtimeMs,
				() => undefined,
			);
			if (modified !== undefined && Date.now() - modified > STALE_STAGING_MS) await discard(entry);
		}
		await removeIfEmpty(moveFolder);
	}
}

/** Makes this attempt's folder. The move's folder is removed whenever it empties, so it is made again when it is gone. */
async function makeAttemptFolder(moveFolder: string): Promise<string> {
	for (;;) {
		await mkdir(moveFolder, { recursive: true });
		try {
			return await mkdtemp(join(moveFolder, ATTEMPT_PREFIX));
		} catch (error) {
			if (!failedWith(error, "ENOENT")) throw error;
		}
	}
}

/**
 * Runs `use` on a staging folder made for this import attempt alone, and removes that folder whatever happens, then
 * the move's folder when nothing else is in it. Before it stages, it removes what imports that died left in this
 * session folder: staging of any move not modified for an hour (`STALE_STAGING_MS`). Younger staging is another
 * attempt's and is never touched.
 */
export async function withStagingAttempt<T>(
	sessionDir: string,
	moveId: MoveId,
	use: (staging: string) => Promise<T>,
): Promise<T> {
	const root = join(sessionDir, STAGING_FOLDER);
	const moveFolder = join(root, encodeURIComponent(moveId));
	await removeStaleStaging(root);
	const staging = await makeAttemptFolder(moveFolder);
	try {
		return await use(staging);
	} finally {
		await discard(staging);
		await removeIfEmpty(moveFolder);
	}
}

class MovedSidecarMissingError extends Error {
	constructor(sidecar: string) {
		super(
			`The moved session was not imported: its ${sidecar} was not in place when it was about to land, so nothing was landed. The move is recorded failed; the sender keeps the session.`,
		);
		this.name = "MovedSidecarMissingError";
	}
}

/**
 * Before the rename that lands the session: every sidecar the manifest lists is in the session folder. The commit moves
 * them out of staging and skips one that is not there, so a sweep that took this attempt's folder inside its commit
 * (senpi#6445's custody review) would land the session without them, accepted. Failing here lands nothing instead.
 */
export async function assertSidecarsLanded(manifest: MoveManifest, sessionDir: string): Promise<void> {
	for (const sidecar of manifest.sidecars) {
		const landed = join(sessionDir, sidecar.path.replace(/^files\//, ""));
		await access(landed).catch(() => {
			throw new MovedSidecarMissingError(sidecar.path.replace(/^files\//, ""));
		});
	}
}

/**
 * Assembles the session in `staging`, as the session folder will hold it: the session file and its sidecars, the
 * payload files, then `session_moved_in` and the queued input. Returns the staged session file, which the commit
 * renames into place.
 */
export async function stageSession(staging: string, bundle: StagedBundle): Promise<string> {
	const { bundleDir, manifest } = bundle;
	const file = join(staging, manifest.sessionFileName);
	for (const item of [manifest.session, ...manifest.sidecars]) {
		const to = item === manifest.session ? file : join(staging, item.path.replace(/^files\//, ""));
		await mkdir(dirname(to), { recursive: true });
		await copyFile(join(bundleDir, item.path), to);
	}
	await stagePayloads(bundleDir, manifest, staging);
	(await SessionManager.openAsync(file, staging)).appendCustomEntry(SESSION_MOVED_IN, {
		move_id: manifest.moveId,
		session_id: manifest.sessionId,
		from: bundle.from,
		bundle_sha256: manifest.session.sha256,
		moved_in_at: new Date().toISOString(),
	});
	await requeueInput(file, manifest.moveId, manifest.droppedUserMessages);
	return file;
}

const extensionStateFiles = (manifest: MoveManifest) =>
	manifest.payloads.filter((payload) => payload.kind === EXTENSION_STATE_PAYLOAD).flatMap((p) => p.files);

/** Copies the payload files into staging and checks each copy, so nothing changed after `verifyBundle` is placed. */
async function stagePayloads(bundleDir: string, manifest: MoveManifest, staging: string): Promise<void> {
	for (const file of manifest.payloads.flatMap((payload) => payload.files)) {
		const to = join(staging, STAGED_PAYLOADS, file.path);
		await mkdir(dirname(to), { recursive: true });
		await copyFile(join(bundleDir, file.path), to);
		if ((await sha256File(to)) !== file.sha256) throw new MoveBundleInvalidError(`${file.path} changed in transit`);
	}
}

export async function placeExtensionState(staging: string, manifest: MoveManifest, dir: string): Promise<void> {
	const files = extensionStateFiles(manifest);
	if (files.length === 0) return;
	await rm(dir, { recursive: true, force: true });
	for (const file of files) {
		const to = join(dir, file.path.slice(EXTENSION_STATE_PREFIX.length));
		await mkdir(dirname(to), { recursive: true });
		await copyFile(join(staging, STAGED_PAYLOADS, file.path), to);
	}
}
