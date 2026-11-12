import { rm } from "node:fs/promises";
import { loadEntriesFromFileAsync, SessionManager } from "../session-manager.ts";
import { pathExists } from "../tools/path-utils.ts";
import { readManifest } from "./bundle.ts";
import { outgoingStateDir } from "./extension-state.ts";
import type { MoveAnswer } from "./move-ledger.ts";
import { moveStep } from "./move-steps.ts";
import {
	headerSessionId,
	isOwnershipEntryType,
	type MoveId,
	SESSION_MOVED,
	SESSION_RECLAIMED,
	sessionOwnership,
} from "./ownership.ts";
import { requeueInput } from "./requeue.ts";
import { withSessionMoveLock } from "./session-lock.ts";

export interface FinishMoveOptions {
	readonly sessionFile: string;
	/** The bundle this device kept while the move was open; it holds the input the release took out. */
	readonly bundleDir: string;
	/** The move the answer is about; the bundle and the file must be about the same move. */
	readonly moveId: MoveId;
	/** The receiver's signed answer. `receiving` changes nothing: the move is still open. */
	readonly answer: MoveAnswer;
	/** Runs inside the move lock before anything is read; throw to refuse. */
	readonly guard?: () => void | Promise<void>;
}

export class MoveMismatchError extends Error {
	readonly code = "move_mismatch";

	constructor(expected: MoveId, found: string, what: string) {
		super(
			`The answer is about move ${expected}, but ${what} belongs to move ${found}; nothing was changed. Finish each move with its own answer and bundle.`,
		);
		this.name = "MoveMismatchError";
	}
}

export class MoveAlreadyMovedError extends Error {
	readonly code = "move_already_moved";

	constructor(moveId: MoveId) {
		super(
			`The receiver revoked its copy for move ${moveId}, but this session file was already marked moved by an earlier accepted answer; nothing was changed and no copy is writable. Copy the session to a new thread to keep working from it.`,
		);
		this.name = "MoveAlreadyMovedError";
	}
}

/**
 * Closes a move on the sending device from the receiver's answer. `accepted` records `session_moved` (read-only for
 * good). `declined`/`failed`, and `accepted` with `revoked` (the receiver sealed its copy), take the session back:
 * `session_reclaimed` makes the file writable, the queued input is re-queued under ids stable per move, then the
 * bundle goes. While the bundle exists the re-queue runs again on the next call, so a crash between any two steps
 * loses nothing and doubles nothing. A revoked answer for a file already marked moved is refused.
 */
/** `heldThisMove`: the session file holds an entry for this move of its own session (only a held file is cleaned up). */
export interface FinishOutcome {
	readonly heldThisMove: boolean;
}

export function finishMove(options: FinishMoveOptions): Promise<FinishOutcome> {
	return withSessionMoveLock(options.sessionFile, () => settleMove(options), options.guard);
}

async function settleMove(options: FinishMoveOptions): Promise<FinishOutcome> {
	const { sessionFile, bundleDir, moveId, answer } = options;
	if (await pathExists(bundleDir)) {
		const bundled = (await readManifest(bundleDir)).moveId;
		if (bundled !== moveId) throw new MoveMismatchError(moveId, bundled, "the kept bundle");
	}
	const entries = await loadEntriesFromFileAsync(sessionFile);
	const ownership = sessionOwnership(entries);
	if (ownership.writable) {
		// The bundle and the staged state are keyed by host, folder and move id, not by file: a file this move never held
		// (never sealed for it, or another file of the folder was) changes nothing (senpi#6484).
		if (!heldByMove(entries, moveId)) return { heldThisMove: false };
		if (reclaimed(entries, moveId)) await requeueDroppedInput(sessionFile, bundleDir);
		await discardMoveFiles(sessionFile, bundleDir, moveId);
		return { heldThisMove: true };
	}
	if (ownership.moveId !== moveId) throw new MoveMismatchError(moveId, ownership.moveId, "the session file");
	if (ownership.state === "moved") {
		if ("revoked" in answer) throw new MoveAlreadyMovedError(moveId);
		await discardMoveFiles(sessionFile, bundleDir, moveId);
		return { heldThisMove: true };
	}
	const sessionId = headerSessionId(entries) ?? "";
	switch (answer.state) {
		case "receiving":
			return { heldThisMove: true };
		case "accepted":
			if ("revoked" in answer) {
				await takeBack(sessionFile, bundleDir, { move_id: moveId, session_id: sessionId, reason: "revoked" });
				break;
			}
			(await SessionManager.openAsync(sessionFile)).appendCustomEntry(SESSION_MOVED, {
				move_id: moveId,
				session_id: sessionId,
				target: ownership.target,
				moved_at: new Date().toISOString(),
			});
			moveStep("finish:recorded");
			break;
		case "declined":
		case "failed":
			await takeBack(sessionFile, bundleDir, {
				move_id: moveId,
				session_id: sessionId,
				reason: answer.state,
				detail: answer.reason,
			});
			break;
		default: {
			const unreachable: never = answer;
			throw new Error(`Unknown move answer ${JSON.stringify(unreachable)}`);
		}
	}
	moveStep("finish:requeued");
	await discardMoveFiles(sessionFile, bundleDir, moveId);
	return { heldThisMove: true };
}

/** Any ownership entry for `moveId` that belongs to the file's own session (an inherited one names another session). */
function heldByMove(entries: readonly { type: string; customType?: string; data?: unknown }[], moveId: MoveId): boolean {
	const own = headerSessionId(entries);
	return entries.some((entry) => {
		if (entry.type !== "custom" || !isOwnershipEntryType(entry.customType)) return false;
		const data = entry.data as { move_id?: unknown; session_id?: unknown } | undefined;
		if (data?.move_id !== moveId) return false;
		return data.session_id === undefined || own === undefined || data.session_id === own;
	});
}

/** `session_reclaimed` makes the file writable again, then the queued input comes back under ids stable per move. */
async function takeBack(sessionFile: string, bundleDir: string, data: Record<string, string>): Promise<void> {
	(await SessionManager.openAsync(sessionFile)).appendCustomEntry(SESSION_RECLAIMED, {
		...data,
		reclaimed_at: new Date().toISOString(),
	});
	moveStep("finish:recorded");
	await requeueDroppedInput(sessionFile, bundleDir);
}

async function discardMoveFiles(sessionFile: string, bundleDir: string, moveId: MoveId): Promise<void> {
	await rm(bundleDir, { recursive: true, force: true });
	await rm(outgoingStateDir(sessionFile, moveId), { recursive: true, force: true });
}

function reclaimed(entries: readonly { type: string; customType?: string; data?: unknown }[], moveId: MoveId): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === SESSION_RECLAIMED &&
			(entry.data as { move_id?: unknown } | undefined)?.move_id === moveId,
	);
}

export async function requeueDroppedInput(sessionFile: string, bundleDir: string): Promise<void> {
	if (!(await pathExists(bundleDir))) return;
	const manifest = await readManifest(bundleDir);
	await requeueInput(sessionFile, manifest.moveId, manifest.droppedUserMessages);
}
