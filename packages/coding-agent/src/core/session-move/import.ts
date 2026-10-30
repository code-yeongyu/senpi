import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import {
	compareRepositoryIdentities,
	type RepositoryIdentity,
	readRepositoryIdentity,
} from "../repository-identity.ts";
import { getDefaultSessionDir, loadEntriesFromFileAsync, SessionManager } from "../session-manager.ts";
import { rebindSessionFile } from "../session-rebind.ts";
import { encodedSessionId, serializeByKey } from "../session-sidecar-store.ts";
import { pathExists } from "../tools/path-utils.ts";
import {
	EXTENSION_STATE_PREFIX,
	MoveBundleInvalidError,
	type MoveManifest,
	readManifest,
	sha256File,
	verifyBundle,
} from "./bundle.ts";
import { EXTENSION_STATE_PAYLOAD, movedStateDir } from "./extension-state.ts";
import { type MoveAnswer, MoveFencedError, type MoveLedger } from "./move-ledger.ts";
import { moveStep } from "./move-steps.ts";
import { headerSessionId, type MoveId, SESSION_MOVED, SESSION_MOVED_IN, sessionOwnership } from "./ownership.ts";
import { requeueInput } from "./requeue.ts";
import { REVOKED } from "./revoke.ts";
import { moveLockKey } from "./session-lock.ts";

export interface ImportMovedSessionOptions {
	readonly bundleDir: string;
	readonly targetCwd: string;
	readonly ledger: MoveLedger;
	readonly sessionDir?: string;
	readonly from?: string;
	readonly readIdentity?: (dir: string) => Promise<RepositoryIdentity | undefined>;
}

export class MoveRefusedError extends Error {
	readonly code: "move_repository_mismatch";

	constructor(targetCwd: string, sourceCwd: string) {
		super(
			`${targetCwd} is not the same repository the session was recorded in (${sourceCwd}). Pick a checkout of the same repository, or copy the session into this folder instead.`,
		);
		this.name = "MoveRefusedError";
		this.code = "move_repository_mismatch";
	}
}

export class MoveTargetOccupiedError extends Error {
	readonly code = "move_target_occupied";

	constructor(target: string) {
		super(
			`A session that can still be written already sits at ${target}; the moved session was not imported over it. Close or move that session first, then send it again.`,
		);
		this.name = "MoveTargetOccupiedError";
	}
}

const movedInFor = async (file: string, moveId: MoveId): Promise<boolean> =>
	(await loadEntriesFromFileAsync(file)).some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === SESSION_MOVED_IN &&
			(entry.data as { move_id?: unknown } | undefined)?.move_id === moveId,
	);

/** What the session file records for the move: nothing, its import, or its import and then a revoke. */
async function importOutcome(file: string, moveId: MoveId): Promise<"absent" | "moved_in" | "revoked"> {
	let outcome: "absent" | "moved_in" | "revoked" = "absent";
	for (const entry of await loadEntriesFromFileAsync(file)) {
		if (entry.type !== "custom") continue;
		const data = entry.data as { move_id?: unknown; reason?: unknown } | undefined;
		if (data?.move_id !== moveId) continue;
		if (entry.customType === SESSION_MOVED_IN) outcome = "moved_in";
		else if (outcome === "moved_in" && entry.customType === SESSION_MOVED && data.reason === REVOKED)
			outcome = "revoked";
	}
	return outcome;
}

export class StatusPathMismatchError extends Error {
	readonly code = "move_mismatch";

	constructor(moveId: MoveId, sessionFile: string) {
		super(
			`${sessionFile} is not the copy this device imported for move ${moveId}; nothing was answered. Pass the session_path import returned for this move, or leave sessionPath out to answer from this device's record.`,
		);
		this.name = "StatusPathMismatchError";
	}
}

/**
 * The sender's question. The ledger answers, its `accepted` final and marked `revoked` once the import is revoked; a
 * given session file is read in the move's queue and is the authority too (a committed import is accepted, a revoked
 * one revoked), so a file that is not this move's import is refused. A path with no file answers from the ledger.
 */
export async function answerMoveStatus(
	ledger: MoveLedger,
	moveId: MoveId,
	sessionFile: string | undefined,
): Promise<MoveAnswer> {
	const landed = async (target: string) => ((await pathExists(target)) ? importOutcome(target, moveId) : "absent");
	if (sessionFile === undefined || !(await pathExists(sessionFile)))
		return ledger.answerStatus(moveId, { movedIn: false, landed });
	return serializeByKey(await moveLockKey(sessionFile), async () => {
		const outcome = await importOutcome(sessionFile, moveId);
		if (outcome === "absent") throw new StatusPathMismatchError(moveId, sessionFile);
		return ledger.answerStatus(moveId, { movedIn: true, revoked: outcome === "revoked", landed });
	});
}

/**
 * Brings a moved session in. The bundle is verified, the folder must be the same repository (the `--rebind` rule),
 * and everything is assembled in a staging folder: the session file gains its queued input back and then
 * `session_moved_in`, so the rename into the session directory, run under the move's ledger lock, is the single
 * commit point. A read-only copy of the same session already here (it moved away earlier) is replaced; a writable
 * one is refused. Importing a bundle already imported returns the session without changing it.
 */
export async function importMovedSession(
	options: ImportMovedSessionOptions,
): Promise<{ readonly sessionFile: string }> {
	const manifest = await readManifest(options.bundleDir);
	const targetCwd = resolvePath(options.targetCwd);
	const sessionDir = options.sessionDir ? normalizePath(options.sessionDir) : getDefaultSessionDir(targetCwd);
	const target = join(sessionDir, manifest.sessionFileName);
	// Once this move's file landed, the move records no failure: only its `accepted` write can have been lost, so it stays
	// receiving and a re-run accepts it. `fail` asks this under the move's lock, where an overlapping commit cannot race it.
	const landed = async (): Promise<boolean> =>
		(await pathExists(target)) && (await movedInFor(target, manifest.moveId));
	if (await landed()) {
		// The rename already committed; a crash or a failed write may have lost `accepted`, and the file is the authority.
		await options.ledger.confirmLanded(
			manifest.moveId,
			target,
			(await importOutcome(target, manifest.moveId)) === "revoked",
		);
		return { sessionFile: target };
	}
	try {
		await verifyBundle(options.bundleDir, manifest);
	} catch (error) {
		if (error instanceof MoveBundleInvalidError)
			await options.ledger.fail(manifest.moveId, "bundle_invalid", { unlessLanded: landed });
		throw error;
	}
	const read = options.readIdentity ?? readRepositoryIdentity;
	if (compareRepositoryIdentities(manifest.repository, await read(targetCwd)) !== "same") {
		if (!(await landed())) await options.ledger.decline(manifest.moveId, "repository");
		throw new MoveRefusedError(targetCwd, manifest.sourceCwd);
	}
	await options.ledger.beginReceive(manifest.moveId, target);
	moveStep("import:received");
	const staging = join(sessionDir, ".move-staging", encodeURIComponent(manifest.moveId));
	try {
		const staged = await stage(options.bundleDir, manifest, staging, options.from ?? "");
		const sessionFile = await options.ledger.commit(
			manifest.moveId,
			target,
			() => rebindSessionFile(staged, targetCwd, sessionDir),
			async () => {
				await replacePredecessor(target, manifest.sessionId, sessionDir);
				// Before the rename: a crash here re-copies on retry, and after it the state is already in place.
				await placeExtensionState(staging, manifest, movedStateDir(target, manifest.moveId));
			},
		);
		moveStep("import:accepted");
		await rm(staging, { recursive: true, force: true });
		return { sessionFile };
	} catch (error) {
		if (!(error instanceof MoveFencedError))
			await options.ledger.fail(
				manifest.moveId,
				error instanceof MoveBundleInvalidError ? "bundle_invalid" : "import_failed",
				{ unlessLanded: landed },
			);
		throw error;
	}
}

/**
 * Only a read-only copy of the same session may be replaced; its sidecars go too so the moved ones take their place.
 * It is removed before the rename: if the rename then fails, the move is recorded `import_failed`, the sender takes
 * the session back, and nothing writable was lost here (the removed copy could not be written).
 */
async function replacePredecessor(target: string, sessionId: string, sessionDir: string): Promise<void> {
	if (!(await pathExists(target))) return;
	const entries = await loadEntriesFromFileAsync(target);
	if (headerSessionId(entries) !== sessionId || sessionOwnership(entries).writable) {
		throw new MoveTargetOccupiedError(target);
	}
	const extensions = join(sessionDir, "extensions");
	if (await pathExists(extensions)) {
		for (const extension of await readdir(extensions, { withFileTypes: true })) {
			if (extension.isDirectory())
				await rm(join(extensions, extension.name, `${encodedSessionId(sessionId)}.json`), { force: true });
		}
	}
	await rm(join(sessionDir, "resident-blobs", sessionId), { recursive: true, force: true });
	await rm(target, { force: true });
}

/** Payload files are staged here, next to the staged session file, and placed from this checked copy. */
const STAGED_PAYLOADS = ".payloads";

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

async function placeExtensionState(staging: string, manifest: MoveManifest, dir: string): Promise<void> {
	const files = extensionStateFiles(manifest);
	if (files.length === 0) return;
	await rm(dir, { recursive: true, force: true });
	for (const file of files) {
		const to = join(dir, file.path.slice(EXTENSION_STATE_PREFIX.length));
		await mkdir(dirname(to), { recursive: true });
		await copyFile(join(staging, STAGED_PAYLOADS, file.path), to);
	}
}

async function stage(bundleDir: string, manifest: MoveManifest, staging: string, from: string): Promise<string> {
	const file = join(staging, manifest.sessionFileName);
	if (!((await pathExists(file)) && (await movedInFor(file, manifest.moveId)))) {
		await rm(staging, { recursive: true, force: true });
		for (const item of [manifest.session, ...manifest.sidecars]) {
			const to = item === manifest.session ? file : join(staging, item.path.replace(/^files\//, ""));
			await mkdir(dirname(to), { recursive: true });
			await copyFile(join(bundleDir, item.path), to);
		}
		await stagePayloads(bundleDir, manifest, staging);
		(await SessionManager.openAsync(file, staging)).appendCustomEntry(SESSION_MOVED_IN, {
			move_id: manifest.moveId,
			session_id: manifest.sessionId,
			from,
			bundle_sha256: manifest.session.sha256,
			moved_in_at: new Date().toISOString(),
		});
	}
	// Ids are stable per move, so a staging pass that crashed after some of these replays them instead of doubling.
	await requeueInput(file, manifest.moveId, manifest.droppedUserMessages);
	return file;
}
