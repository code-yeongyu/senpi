import { rm } from "node:fs/promises";
import { loadEntriesFromFileAsync, SessionManager } from "../session-manager.ts";
import { pathExists } from "../tools/path-utils.ts";
import { readKeptBundle } from "./bundle.ts";
import { readDroppedInputRecord } from "./dropped-input-record.ts";
import { outgoingStateDir } from "./extension-state.ts";
import type { MoveAnswer } from "./move-ledger.ts";
import { moveStep } from "./move-steps.ts";
import { headerSessionId, type MoveId, SESSION_MOVED, SESSION_RECLAIMED, sessionOwnership } from "./ownership.ts";
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
 * bundle goes. The input is read from the kept bundle's manifest, or - when no export ever wrote one, because it
 * failed or never ran (senpi#6474, senpi#3962) - from the record the release itself left under the move id. While
 * either exists the re-queue runs again on the next call, so a crash between any two steps loses nothing and doubles
 * nothing. A revoked answer for a file already marked moved is refused.
 */
export function finishMove(options: FinishMoveOptions): Promise<void> {
	return withSessionMoveLock(options.sessionFile, () => settleMove(options), options.guard);
}

async function settleMove(options: FinishMoveOptions): Promise<void> {
	const { sessionFile, bundleDir, moveId, answer } = options;
	if (await pathExists(bundleDir)) {
		const bundled = (await readKeptBundle(bundleDir)).moveId;
		if (bundled !== moveId) throw new MoveMismatchError(moveId, bundled, "the kept bundle");
	}
	const entries = await loadEntriesFromFileAsync(sessionFile);
	const ownership = sessionOwnership(entries);
	if (ownership.writable) {
		if (reclaimed(entries, moveId)) await requeueDroppedInput(sessionFile, bundleDir, moveId);
		await discardMoveFiles(sessionFile, bundleDir, moveId);
		return;
	}
	if (ownership.moveId !== moveId) throw new MoveMismatchError(moveId, ownership.moveId, "the session file");
	if (ownership.state === "moved") {
		if ("revoked" in answer) throw new MoveAlreadyMovedError(moveId);
		await discardMoveFiles(sessionFile, bundleDir, moveId);
		return;
	}
	const sessionId = headerSessionId(entries) ?? "";
	switch (answer.state) {
		case "receiving":
			return;
		case "accepted":
			if ("revoked" in answer) {
				await takeBack(sessionFile, bundleDir, moveId, {
					move_id: moveId,
					session_id: sessionId,
					reason: "revoked",
				});
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
			await takeBack(sessionFile, bundleDir, moveId, {
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
}

/** `session_reclaimed` makes the file writable again, then the queued input comes back under ids stable per move. */
async function takeBack(
	sessionFile: string,
	bundleDir: string,
	moveId: MoveId,
	data: Record<string, string>,
): Promise<void> {
	(await SessionManager.openAsync(sessionFile)).appendCustomEntry(SESSION_RECLAIMED, {
		...data,
		reclaimed_at: new Date().toISOString(),
	});
	moveStep("finish:recorded");
	await requeueDroppedInput(sessionFile, bundleDir, moveId);
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

export async function requeueDroppedInput(sessionFile: string, bundleDir: string, moveId: MoveId): Promise<void> {
	if (await pathExists(bundleDir)) {
		const kept = await readKeptBundle(bundleDir);
		// The release's own record outranks a manifest that carries less than the release drained (an older
		// build, or a caller without the answer, emptied it): the engine's memory of its queue decides.
		const recorded = await readDroppedInputRecord(sessionFile, moveId);
		const texts = recorded.length > 0 ? recorded : kept.droppedUserMessages;
		await requeueInput(sessionFile, kept.moveId, texts);
		return;
	}
	// No manifest was ever written: the record the release itself left under the move id is what is left
	// (senpi#6474, senpi#3962), re-queued under the same stable per-move ids as the bundle's copy.
	await requeueInput(sessionFile, moveId, await readDroppedInputRecord(sessionFile, moveId));
}
