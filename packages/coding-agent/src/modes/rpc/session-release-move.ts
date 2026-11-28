import { rm } from "node:fs/promises";
import type { AgentSession } from "../../core/agent-session.ts";
import { readDroppedInputRecord, writeDroppedInputRecord } from "../../core/session-move/dropped-input-record.ts";
import { assertMoveFits } from "../../core/session-move/export.ts";
import { prepareOutgoingState, sealedAttempt } from "../../core/session-move/extension-state.ts";
import type { MoveId } from "../../core/session-move/ownership.ts";
import type { ReleaseDropped } from "./session-release-interrupt.ts";

export interface StagedMoveRelease {
	/** This attempt's staging folder; `undefined` when an earlier release of the move already sealed the session. */
	readonly stagedState: { readonly attempt: string; readonly dir: string } | undefined;
	/** What the move owes once sealed: input an earlier sealed release of it took, then what this one took. */
	readonly owed: ReleaseDropped;
}

export function sealedForMove(session: AgentSession, moveId: string | undefined): boolean {
	const ownership = session.sessionManager.getOwnership();
	return !ownership.writable && ownership.state === "moving" && ownership.moveId === moveId;
}

/**
 * Everything a `move` release does before its seal. Extensions write their out-of-folder state while their runtime is
 * still live, under the session_shutdown handler budget, and state a bundle could not carry refuses the release here,
 * while the session stays live. The queued input the release took is on disk, under the attempt the seal will name,
 * before any answer can leave it behind (senpi#6474, senpi#3962). A release asked again for a move an earlier release
 * already sealed stages nothing and re-answers what that release recorded. A failure removes this attempt's folder.
 */
export async function stageMoveRelease(
	session: AgentSession,
	sessionPath: string,
	moveId: MoveId,
	taken: ReleaseDropped,
): Promise<StagedMoveRelease> {
	const manager = session.sessionManager;
	if (sealedForMove(session, moveId)) {
		const prior = await readDroppedInputRecord(sessionPath, moveId);
		const attempt = sealedAttempt(manager.getEntries(), moveId);
		const owed = [...prior, ...taken.user_messages];
		if (taken.user_messages.length > 0 && attempt !== undefined)
			await writeDroppedInputRecord(sessionPath, moveId, { sessionId: manager.getSessionId(), attempt }, owed);
		return { stagedState: undefined, owed: { ...taken, user_messages: owed } };
	}
	const stagedState = await prepareOutgoingState(sessionPath, moveId);
	try {
		const [failed] = await session.extensionRunner.emitSessionMove({
			type: "session_move_export",
			moveId,
			dir: stagedState.dir,
		});
		if (failed !== undefined)
			throw new Error(`${failed.extensionPath} could not write its state for the move: ${failed.error}`);
		await assertMoveFits(sessionPath, manager.getSessionId(), stagedState.dir, false);
		if (taken.user_messages.length > 0) {
			const owner = { sessionId: manager.getSessionId(), attempt: stagedState.attempt };
			await writeDroppedInputRecord(sessionPath, moveId, owner, taken.user_messages);
		}
	} catch (cause) {
		await rm(stagedState.dir, { recursive: true, force: true });
		throw cause;
	}
	return { stagedState, owed: taken };
}
