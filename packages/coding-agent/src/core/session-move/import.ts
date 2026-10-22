import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import {
	compareRepositoryIdentities,
	type RepositoryIdentity,
	readRepositoryIdentity,
} from "../repository-identity.ts";
import { getDefaultSessionDir, loadEntriesFromFile, SessionManager } from "../session-manager.ts";
import { rebindSessionFile } from "../session-rebind.ts";
import { encodedSessionId } from "../session-sidecar-store.ts";
import {
	EXTENSION_STATE_PREFIX,
	MoveBundleInvalidError,
	type MoveManifest,
	readManifest,
	sha256File,
	verifyBundle,
} from "./bundle.ts";
import { EXTENSION_STATE_PAYLOAD, movedStateDir } from "./extension-state.ts";
import { MoveFencedError, type MoveLedger, type MoveStatus } from "./move-ledger.ts";
import { headerSessionId, type MoveId, SESSION_MOVED_IN, sessionOwnership } from "./ownership.ts";
import { requeueInput } from "./requeue.ts";

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

const movedInFor = (file: string, moveId: MoveId): boolean =>
	loadEntriesFromFile(file).some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === SESSION_MOVED_IN &&
			(entry.data as { move_id?: unknown } | undefined)?.move_id === moveId,
	);

/** The sender's question, answered with the session file as the authority: a committed import is accepted. */
export function answerMoveStatus(
	ledger: MoveLedger,
	moveId: MoveId,
	sessionFile: string | undefined,
): Promise<MoveStatus> {
	const movedIn = sessionFile !== undefined && existsSync(sessionFile) && movedInFor(sessionFile, moveId);
	return ledger.answerStatus(moveId, { movedIn });
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
	const landed = () => existsSync(target) && movedInFor(target, manifest.moveId);
	if (landed()) {
		// The rename already committed; a crash or a failed write may have lost `accepted`, and the file is the authority.
		await options.ledger.accept(manifest.moveId);
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
		if (!landed()) await options.ledger.decline(manifest.moveId, "repository");
		throw new MoveRefusedError(targetCwd, manifest.sourceCwd);
	}
	await options.ledger.beginReceive(manifest.moveId);
	const staging = join(sessionDir, ".move-staging", encodeURIComponent(manifest.moveId));
	try {
		const staged = await stage(options.bundleDir, manifest, staging, options.from ?? "");
		const sessionFile = await options.ledger.commit(manifest.moveId, () => {
			replacePredecessor(target, manifest.sessionId, sessionDir);
			// Before the rename: a crash here re-copies on retry, and after it the state is already in place.
			placeExtensionState(staging, manifest, movedStateDir(target, manifest.moveId));
			return rebindSessionFile(staged, targetCwd, sessionDir);
		});
		rmSync(staging, { recursive: true, force: true });
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
function replacePredecessor(target: string, sessionId: string, sessionDir: string): void {
	if (!existsSync(target)) return;
	const entries = loadEntriesFromFile(target);
	if (headerSessionId(entries) !== sessionId || sessionOwnership(entries).writable) {
		throw new MoveTargetOccupiedError(target);
	}
	const extensions = join(sessionDir, "extensions");
	if (existsSync(extensions)) {
		for (const extension of readdirSync(extensions, { withFileTypes: true })) {
			if (extension.isDirectory())
				rmSync(join(extensions, extension.name, `${encodedSessionId(sessionId)}.json`), { force: true });
		}
	}
	rmSync(join(sessionDir, "resident-blobs", sessionId), { recursive: true, force: true });
	rmSync(target, { force: true });
}

/** Payload files are staged here, next to the staged session file, and placed from this checked copy. */
const STAGED_PAYLOADS = ".payloads";

const extensionStateFiles = (manifest: MoveManifest) =>
	manifest.payloads.filter((payload) => payload.kind === EXTENSION_STATE_PAYLOAD).flatMap((p) => p.files);

/** Copies the payload files into staging and checks each copy, so nothing changed after `verifyBundle` is placed. */
async function stagePayloads(bundleDir: string, manifest: MoveManifest, staging: string): Promise<void> {
	for (const file of manifest.payloads.flatMap((payload) => payload.files)) {
		const to = join(staging, STAGED_PAYLOADS, file.path);
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(join(bundleDir, file.path), to);
		if ((await sha256File(to)) !== file.sha256) throw new MoveBundleInvalidError(`${file.path} changed in transit`);
	}
}

function placeExtensionState(staging: string, manifest: MoveManifest, dir: string): void {
	const files = extensionStateFiles(manifest);
	if (files.length === 0) return;
	rmSync(dir, { recursive: true, force: true });
	for (const file of files) {
		const to = join(dir, file.path.slice(EXTENSION_STATE_PREFIX.length));
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(join(staging, STAGED_PAYLOADS, file.path), to);
	}
}

async function stage(bundleDir: string, manifest: MoveManifest, staging: string, from: string): Promise<string> {
	const file = join(staging, manifest.sessionFileName);
	if (!(existsSync(file) && movedInFor(file, manifest.moveId))) {
		rmSync(staging, { recursive: true, force: true });
		for (const item of [manifest.session, ...manifest.sidecars]) {
			const to = item === manifest.session ? file : join(staging, item.path.replace(/^files\//, ""));
			mkdirSync(dirname(to), { recursive: true });
			copyFileSync(join(bundleDir, item.path), to);
		}
		await stagePayloads(bundleDir, manifest, staging);
		SessionManager.open(file, staging).appendCustomEntry(SESSION_MOVED_IN, {
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
