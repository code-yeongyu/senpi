import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import {
	compareRepositoryIdentities,
	type RepositoryIdentity,
	readRepositoryIdentity,
} from "../repository-identity.ts";
import { getDefaultSessionDir, loadEntriesFromFileAsync } from "../session-manager.ts";
import { rebindSessionFile } from "../session-rebind.ts";
import { encodedSessionId, serializeByKey } from "../session-sidecar-store.ts";
import { pathExists } from "../tools/path-utils.ts";
import { MoveBundleInvalidError, readManifest, verifyBundle } from "./bundle.ts";
import { movedStateDir } from "./extension-state.ts";
import { placeExtensionState, stageSession, withStagingAttempt } from "./import-staging.ts";
import { type MoveAnswer, MoveFencedError, type MoveLedger } from "./move-ledger.ts";
import { moveStep } from "./move-steps.ts";
import { headerSessionId, type MoveId, SESSION_MOVED, SESSION_MOVED_IN, sessionOwnership } from "./ownership.ts";
import { REVOKED } from "./revoke.ts";
import { moveLockKey } from "./session-lock.ts";

export interface ImportMovedSessionOptions {
	readonly bundleDir: string;
	readonly targetCwd: string;
	readonly ledger: MoveLedger;
	readonly sessionDir?: string;
	readonly from?: string;
	/** The sha256 each file of an inline bundle was sent with (senpi#6267); checked beside the manifest's. */
	readonly sent?: ReadonlyMap<string, string>;
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
 * and everything is assembled in a staging folder of this attempt's own (`import-staging.ts`): the session file gains
 * `session_moved_in` and its queued input back, so the rename into the session directory, run under the move's ledger
 * lock, is the single commit point. A read-only copy of the same session already here (it moved away earlier) is
 * replaced; a writable one is refused. Importing a bundle already imported returns the session without changing it.
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
	// The rename already committed; a crash or a failed write may have lost `accepted`, and the file is the authority.
	const confirmLanded = async (): Promise<{ readonly sessionFile: string }> => {
		await options.ledger.confirmLanded(
			manifest.moveId,
			target,
			(await importOutcome(target, manifest.moveId)) === "revoked",
		);
		return { sessionFile: target };
	};
	if (await landed()) return confirmLanded();
	try {
		await verifyBundle(options.bundleDir, manifest, options.sent);
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
	try {
		await options.ledger.beginReceive(manifest.moveId, target);
	} catch (error) {
		// Another import of this move may have landed the file since this one looked for it: then the file answers.
		if (error instanceof MoveFencedError && (await landed())) return confirmLanded();
		throw error;
	}
	moveStep("import:received");
	try {
		const sessionFile = await withStagingAttempt(sessionDir, manifest.moveId, async (staging) => {
			const staged = await stageSession(staging, {
				bundleDir: options.bundleDir,
				manifest,
				from: options.from ?? "",
			});
			const landedFile = await options.ledger.commit(
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
			return landedFile;
		});
		return { sessionFile };
	} catch (error) {
		// Another import landed this move: the landed file answers.
		if (error instanceof MoveFencedError && (await landed())) return confirmLanded();
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
