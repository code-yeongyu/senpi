import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { SessionHeldError } from "../session-hold-errors.ts";
import { liveSessionHolders } from "../session-holders.ts";
import { loadEntriesFromFile, SessionManager } from "../session-manager.ts";
import { readRecordedRepositoryIdentity, readSessionCwd } from "../session-rebind.ts";
import { encodedSessionId } from "../session-sidecar-store.ts";
import {
	type BundleFile,
	MANIFEST_FILE,
	MOVE_BUNDLE_FORMAT,
	type MoveManifest,
	parseMoveId,
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
import { captureWorkingTree, checkHeadOnRemote, WORKING_TREE_PAYLOAD } from "./working-tree.ts";

export interface ExportSessionForMoveOptions {
	/** A session no live runtime holds: an RPC host releases it first (`release_session` reason `move`). */
	readonly sessionFile: string;
	readonly moveId: MoveId;
	readonly target: string;
	/** Queued user input the release took out of the session (`dropped.user_messages`), in order. */
	readonly droppedUserMessages: readonly string[];
	readonly bundleDir: string;
	/** What the extensions wrote at the move release (`outgoingStateDir`); bundled as the `extension-state` payload. */
	readonly extensionStateDir?: string;
	/** Carry the uncommitted changes of the session's folder (`working-tree` payload) when it is a git checkout. */
	readonly workingTree?: boolean;
}

/**
 * Seals the session for the move (a `session_released` entry with reason `move`; from then on this device refuses
 * writes) and writes a self-verifying bundle: the session file, its extension sidecars and resident blobs, and a
 * manifest. Running it again for the same move rewrites the same bundle without a second release entry.
 */
export function exportSessionForMove(options: ExportSessionForMoveOptions): Promise<MoveManifest> {
	return withSessionMoveLock(options.sessionFile, () => writeMoveBundle(options));
}

async function writeMoveBundle(options: ExportSessionForMoveOptions): Promise<MoveManifest> {
	const { sessionFile } = options;
	const moveId = parseMoveId(options.moveId);
	const entries = loadEntriesFromFile(sessionFile);
	const sessionId = headerSessionId(entries) ?? "";
	// A live runtime could still write the transcript, its sidecars or its resident blobs after the seal.
	const holders = await liveSessionHolders(sessionFile, sessionId);
	if (holders.length > 0) throw new SessionHeldError(sessionFile, holders);
	const ownership = sessionOwnership(entries);
	if (!ownership.writable && !(ownership.state === "moving" && ownership.moveId === moveId)) {
		throw new SessionMovedAwayError(sessionFile, ownership);
	}
	if (ownership.writable) {
		SessionManager.open(sessionFile).appendCustomEntry(SESSION_RELEASED, {
			reason: "move",
			move_id: moveId,
			session_id: sessionId,
			target: options.target,
			released_at: new Date().toISOString(),
		});
	}
	const staging = `${options.bundleDir}.partial-${process.pid}`;
	rmSync(staging, { recursive: true, force: true });
	mkdirSync(join(staging, dirname(SESSION_BUNDLE_PATH)), { recursive: true });
	copyFileSync(sessionFile, join(staging, SESSION_BUNDLE_PATH));
	const sidecars = copySidecars(dirname(sessionFile), sessionId, staging);
	const stateFiles = copyExtensionState(options.extensionStateDir, staging);
	const treeFiles = options.workingTree === true ? await stageWorkingTree(sessionFile, staging) : [];
	const manifest: MoveManifest = {
		format: MOVE_BUNDLE_FORMAT,
		moveId,
		sessionId,
		sessionFileName: basename(sessionFile),
		sourceCwd: readSessionCwd(sessionFile) ?? "",
		repository: readRecordedRepositoryIdentity(sessionFile),
		session: { path: SESSION_BUNDLE_PATH, sha256: sha256File(join(staging, SESSION_BUNDLE_PATH)) },
		sidecars,
		droppedUserMessages: [...options.droppedUserMessages],
		payloads: [
			...(stateFiles.length > 0 ? [{ kind: EXTENSION_STATE_PAYLOAD, files: stateFiles }] : []),
			...(treeFiles.length > 0 ? [{ kind: WORKING_TREE_PAYLOAD, files: treeFiles }] : []),
		],
	};
	writeFileSync(join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 1)}\n`);
	rmSync(options.bundleDir, { recursive: true, force: true });
	renameSync(staging, options.bundleDir);
	return manifest;
}

function copySidecars(sessionDir: string, sessionId: string, staging: string): BundleFile[] {
	const sources: string[] = [];
	const extensions = join(sessionDir, "extensions");
	const sidecarName = `${encodedSessionId(sessionId)}.json`;
	if (existsSync(extensions)) {
		for (const extension of readdirSync(extensions, { withFileTypes: true })) {
			const file = join(extensions, extension.name, sidecarName);
			if (extension.isDirectory() && existsSync(file)) sources.push(file);
		}
	}
	sources.push(...filesUnder(join(sessionDir, "resident-blobs", sessionId)));
	return sources.map((source) => {
		const path = join("files", relative(sessionDir, source));
		mkdirSync(dirname(join(staging, path)), { recursive: true });
		copyFileSync(source, join(staging, path));
		return { path, sha256: sha256File(join(staging, path)) };
	});
}

function copyExtensionState(dir: string | undefined, staging: string): BundleFile[] {
	if (dir === undefined) return [];
	return filesUnder(dir).map((source) => {
		const path = join("state", relative(dir, source));
		mkdirSync(dirname(join(staging, path)), { recursive: true });
		copyFileSync(source, join(staging, path));
		return { path, sha256: sha256File(join(staging, path)) };
	});
}

async function stageWorkingTree(sessionFile: string, staging: string): Promise<BundleFile[]> {
	const cwd = readSessionCwd(sessionFile);
	if (cwd === undefined || !existsSync(cwd)) return [];
	const head = await checkHeadOnRemote(cwd);
	if (!head.ok && head.code === "not_a_repository") return [];
	const dir = join(staging, "tree");
	const captured = await captureWorkingTree(cwd, dir);
	if (!captured.changed) {
		rmSync(dir, { recursive: true, force: true });
		return [];
	}
	return filesUnder(dir).map((file) => {
		const path = join("tree", relative(dir, file));
		return { path, sha256: sha256File(file) };
	});
}

function filesUnder(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
	);
}
