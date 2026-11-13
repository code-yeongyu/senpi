import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { RepositoryIdentity } from "../repository-identity.ts";
import { getDefaultSessionDir, loadEntriesFromFileAsync, SessionManager } from "../session-manager.ts";
import { readSessionCwd, rebindSessionFile } from "../session-rebind.ts";
import { encodedSessionId, serializeByKey } from "../session-sidecar-store.ts";
import { pathExists } from "../tools/path-utils.ts";
import {
	EXTENSION_STATE_PREFIX,
	listedFiles,
	MoveBundleInvalidError,
	type MoveManifest,
	readManifest,
	sha256File,
	verifyBundle,
} from "./bundle.ts";
import { EXTENSION_STATE_PAYLOAD, movedStateDir } from "./extension-state.ts";
import { type LandedFile, outcomeIn, readLanding } from "./landed-file.ts";
import { type MoveAnswer, MoveFencedError, type MoveLedger } from "./move-ledger.ts";
import { moveStep } from "./move-steps.ts";
import { type NameFolding, refuseNamesThatFold } from "./name-folding.ts";
import { STAGED_PAYLOADS, stagedName, stagedNames } from "./staged-layout.ts";
import { headerSessionId, type MoveId, SESSION_MOVED_IN, sessionOwnership } from "./ownership.ts";
import { requeueInput } from "./requeue.ts";
import { isCheckoutOfRepository, MoveRefusedError } from "./repository-check.ts";
import { moveLockKey } from "./session-lock.ts";

export { MoveRefusedError } from "./repository-check.ts";

export interface ImportMovedSessionOptions {
	readonly bundleDir: string;
	readonly targetCwd: string;
	readonly ledger: MoveLedger;
	readonly sessionDir?: string;
	readonly from?: string;
	/** The sha256 each file of an inline bundle was sent with (senpi#6267); checked beside the manifest's. */
	readonly sent?: ReadonlyMap<string, string>;
	readonly readIdentity?: (dir: string) => Promise<RepositoryIdentity | undefined>;
	/** How the session folder's file system folds names (senpi#6472); asked of the folder itself unless a test says. */
	readonly probeNameFolding?: (folder: string) => Promise<NameFolding>;
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

const importOutcome = async (file: string, moveId: MoveId) => outcomeIn(await loadEntriesFromFileAsync(file), moveId);

export class StatusPathMismatchError extends Error {
	readonly code = "move_mismatch";

	constructor(moveId: MoveId, sessionFile: string) {
		super(
			`${sessionFile} is not the copy this device imported for move ${moveId}; nothing was answered. Pass the session_path import returned for this move, or leave sessionPath out to answer from this device's record.`,
		);
		this.name = "StatusPathMismatchError";
	}
}

/** The session file a `status` asks about, and what it is to the move. */
export interface StatusFile {
	readonly file: string;
	/** `copy`: the copy the import returned, which must record the move. `landing`: where the move would have landed. */
	readonly as: "copy" | "landing";
}

/**
 * The sender's question. The ledger answers, its `accepted` final and marked `revoked` once the import is revoked; a
 * given session file is read in the move's queue and is the authority too (a committed import is accepted, a revoked
 * one revoked), so a file that is not this move's import is refused. A path with no file answers from the ledger.
 *
 * For an accepted move it also says where it landed (senpi#6436). To settle an interrupted step the ledger reads the
 * file at the target its record names, under the record's lock; that same read says what the file is, so nothing is
 * read twice and nothing is opened or written for it. A record that names no target says nothing.
 *
 * A `landing` is read before the ledger is asked, so a move that landed answers `accepted` from its file even when its
 * record is lost, and no record is made for it. A file there that does not record this move (the copy an earlier move
 * of the session left, another session) is no landing: the ledger answers, as it does when no file is there.
 */
export async function answerMoveStatusAndLanding(
	ledger: MoveLedger,
	moveId: MoveId,
	asked: StatusFile | undefined,
): Promise<{ readonly answer: MoveAnswer; readonly landed?: LandedFile }> {
	const seen: { file?: LandedFile; landing?: LandedFile } = {};
	const landed = async (target: string) => {
		const { outcome, file } = await readLanding(target, moveId);
		seen.file = file;
		return outcome;
	};
	const fromLedger = () => ledger.answerStatus(moveId, { movedIn: false, landed });
	const answer =
		asked === undefined || !(await pathExists(asked.file))
			? await fromLedger()
			: await serializeByKey(await moveLockKey(asked.file), async () => {
					const { outcome, file } = await readLanding(asked.file, moveId);
					if (outcome === "absent") {
						if (asked.as === "copy") throw new StatusPathMismatchError(moveId, asked.file);
						return fromLedger();
					}
					if (asked.as === "landing") seen.landing = file;
					return ledger.answerStatus(moveId, { movedIn: true, revoked: outcome === "revoked", landed });
				});
	// Where the record says the move landed; a lost record says nothing, and then the landing just read is the place.
	const where = seen.file ?? seen.landing;
	return answer.state === "accepted" && where !== undefined ? { answer, landed: where } : { answer };
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
	// The rename already committed; a crash or a failed write may have lost `accepted`, and the file is the authority.
	// It answers only for the folder it landed for: an import that names another folder (into the same `sessionDir`)
	// was never checked against that folder's repository, and its `open` would run the session there. That import is
	// fenced with the record the file just confirmed, so its refusal says where the move landed (senpi#6436).
	const confirmLanded = async (): Promise<{ readonly sessionFile: string }> => {
		const revoked = (await importOutcome(target, manifest.moveId)) === "revoked";
		await options.ledger.confirmLanded(manifest.moveId, target, revoked);
		const landedFor = await readSessionCwd(target);
		if (landedFor !== undefined && landedFor !== targetCwd)
			throw new MoveFencedError(
				manifest.moveId,
				revoked ? { state: "accepted", revoked: true } : { state: "accepted" },
				`it already landed here for ${landedFor}, and a move lands for one folder`,
			);
		return { sessionFile: target };
	};
	if (await landed()) return confirmLanded();
	// Every listed file is written under the session folder: two that are one name on its file system cannot both be.
	// The names a staged move writes are not the bundle's paths, so both layouts are asked. Refused before the move is
	// touched, so it stays importable into a folder that keeps them apart.
	await refuseNamesThatFold(
		[listedFiles(manifest).map((file) => file.path), stagedNames(manifest)],
		sessionDir,
		options.probeNameFolding,
	);
	try {
		await verifyBundle(options.bundleDir, manifest, options.sent);
	} catch (error) {
		if (error instanceof MoveBundleInvalidError)
			await options.ledger.fail(manifest.moveId, "bundle_invalid", { unlessLanded: landed });
		throw error;
	}
	// Before the repository check: an import into a folder this move was not readied for must not decline the move,
	// which that check does, because the move still lands in the folder its `prepare` checked (senpi#6435).
	await options.ledger.requireReadiedFor(manifest.moveId, targetCwd);
	if (!(await isCheckoutOfRepository(targetCwd, manifest.repository, options.readIdentity))) {
		if (!(await landed())) await options.ledger.decline(manifest.moveId, "repository");
		throw new MoveRefusedError(targetCwd, manifest.sourceCwd);
	}
	try {
		await options.ledger.beginReceive(manifest.moveId, target, { cwd: targetCwd });
	} catch (error) {
		// Another import of this move may have landed the file since this one looked for it: then the file answers.
		if (error instanceof MoveFencedError && (await landed())) return confirmLanded();
		throw error;
	}
	moveStep("import:received");
	const staging = join(sessionDir, ".move-staging", encodeURIComponent(manifest.moveId));
	try {
		const staged = await stage(options.bundleDir, manifest, staging, options.from ?? "");
		const sessionFile = await options.ledger.commit(
			manifest.moveId,
			target,
			(stampStands) => rebindSessionFile(staged, targetCwd, sessionDir, { beforeRename: stampStands }),
			async () => {
				const assertHeld = () => options.ledger.assertHeld(manifest.moveId);
				await replacePredecessor(target, manifest.sessionId, sessionDir, assertHeld);
				// Before the rename: a crash here re-copies on retry, and after it the state is already in place.
				await placeExtensionState(staging, manifest, movedStateDir(target, manifest.moveId), assertHeld);
			},
		);
		moveStep("import:accepted");
		await rm(staging, { recursive: true, force: true });
		return { sessionFile };
	} catch (error) {
		// Another import landed this move; what this one staged after that import cleaned up is not kept. The folder is
		// clutter only, so a removal that fails never replaces the answer the landed file gives.
		if (error instanceof MoveFencedError && (await landed())) {
			await rm(staging, { recursive: true, force: true }).catch(() => undefined);
			return confirmLanded();
		}
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
async function replacePredecessor(
	target: string,
	sessionId: string,
	sessionDir: string,
	assertHeld: () => void,
): Promise<void> {
	if (!(await pathExists(target))) return;
	const entries = await loadEntriesFromFileAsync(target);
	if (headerSessionId(entries) !== sessionId || sessionOwnership(entries).writable) {
		throw new MoveTargetOccupiedError(target);
	}
	const extensions = join(sessionDir, "extensions");
	if (await pathExists(extensions)) {
		for (const extension of await readdir(extensions, { withFileTypes: true })) {
			if (extension.isDirectory()) {
				assertHeld();
				await rm(join(extensions, extension.name, `${encodedSessionId(sessionId)}.json`), { force: true });
			}
		}
	}
	assertHeld();
	await rm(join(sessionDir, "resident-blobs", sessionId), { recursive: true, force: true });
	assertHeld();
	await rm(target, { force: true });
}

/** Payload files are staged here, next to the staged session file, and placed from this checked copy. */

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

async function placeExtensionState(
	staging: string,
	manifest: MoveManifest,
	dir: string,
	assertHeld: () => void,
): Promise<void> {
	const files = extensionStateFiles(manifest);
	if (files.length === 0) return;
	assertHeld();
	await rm(dir, { recursive: true, force: true });
	for (const file of files) {
		const to = join(dir, file.path.slice(EXTENSION_STATE_PREFIX.length));
		assertHeld();
		await mkdir(dirname(to), { recursive: true });
		assertHeld();
		await copyFile(join(staging, STAGED_PAYLOADS, file.path), to);
	}
}

async function stage(bundleDir: string, manifest: MoveManifest, staging: string, from: string): Promise<string> {
	const file = join(staging, manifest.sessionFileName);
	if (!((await pathExists(file)) && (await movedInFor(file, manifest.moveId)))) {
		await rm(staging, { recursive: true, force: true });
		for (const item of [manifest.session, ...manifest.sidecars]) {
			const to = item === manifest.session ? file : join(staging, stagedName(manifest, item));
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
