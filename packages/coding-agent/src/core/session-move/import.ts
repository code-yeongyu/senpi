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
import { MoveBundleInvalidError, type MoveManifest, readManifest, verifyBundle } from "./bundle.ts";
import { EXTENSION_STATE_PAYLOAD, movedStateDir } from "./extension-state.ts";
import { MoveFencedError, type MoveLedger, type MoveStatus } from "./move-ledger.ts";
import { headerSessionId, type MoveId, SESSION_MOVED_IN, sessionOwnership } from "./ownership.ts";
import { requeueInput } from "./requeue.ts";
import { type ApplyResult, applyWorkingTree, movedTreeDir, WORKING_TREE_PAYLOAD } from "./working-tree.ts";

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
): Promise<{ readonly sessionFile: string; readonly workingTree?: ApplyResult }> {
	const manifest = readManifest(options.bundleDir);
	const targetCwd = resolvePath(options.targetCwd);
	const sessionDir = options.sessionDir ? normalizePath(options.sessionDir) : getDefaultSessionDir(targetCwd);
	const target = join(sessionDir, manifest.sessionFileName);
	if (existsSync(target) && movedInFor(target, manifest.moveId)) {
		// The rename already committed; a crash may have lost the ledger write, and the file is the authority.
		await options.ledger.commit(manifest.moveId, () => undefined);
		return { sessionFile: target };
	}
	try {
		verifyBundle(options.bundleDir, manifest);
	} catch (error) {
		if (error instanceof MoveBundleInvalidError) await options.ledger.fail(manifest.moveId, "bundle_invalid");
		throw error;
	}
	const read = options.readIdentity ?? readRepositoryIdentity;
	if (compareRepositoryIdentities(manifest.repository, await read(targetCwd)) !== "same") {
		await options.ledger.decline(manifest.moveId, "repository");
		throw new MoveRefusedError(targetCwd, manifest.sourceCwd);
	}
	await options.ledger.beginReceive(manifest.moveId);
	const staging = join(sessionDir, ".move-staging", encodeURIComponent(manifest.moveId));
	try {
		const staged = await stage(options.bundleDir, manifest, staging, options.from ?? "");
		const sessionFile = await options.ledger.commit(manifest.moveId, () => {
			replacePredecessor(target, manifest.sessionId, sessionDir);
			// Before the rename: a crash here re-copies on retry, and after it the state is already in place.
			placePayload(
				options.bundleDir,
				manifest,
				EXTENSION_STATE_PAYLOAD,
				"state/",
				movedStateDir(target, manifest.moveId),
			);
			placePayload(
				options.bundleDir,
				manifest,
				WORKING_TREE_PAYLOAD,
				"tree/",
				movedTreeDir(target, manifest.moveId),
			);
			return rebindSessionFile(staged, targetCwd, sessionDir);
		});
		rmSync(staging, { recursive: true, force: true });
		const tree = movedTreeDir(target, manifest.moveId);
		return existsSync(tree) ? { sessionFile, workingTree: await applyWorkingTree(targetCwd, tree) } : { sessionFile };
	} catch (error) {
		if (!(error instanceof MoveFencedError)) await options.ledger.fail(manifest.moveId, "import_failed");
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

function placePayload(bundleDir: string, manifest: MoveManifest, kind: string, prefix: string, dir: string): void {
	const files = manifest.payloads.filter((payload) => payload.kind === kind).flatMap((p) => p.files);
	if (files.length === 0) return;
	rmSync(dir, { recursive: true, force: true });
	for (const file of files) {
		const to = join(dir, file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path);
		mkdirSync(dirname(to), { recursive: true });
		copyFileSync(join(bundleDir, file.path), to);
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
