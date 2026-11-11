/**
 * The `move_session` answers that say where an accepted move landed (senpi#6436): `status`, and an `import` refused
 * because the move already landed. Whoever may send the import may ask; nothing is opened, held or rewritten for it.
 */
import { answerMoveStatusAndLanding } from "../../core/session-move/import.ts";
import type { LandedFile } from "../../core/session-move/landed-file.ts";
import { MoveFencedError, type MoveLedger } from "../../core/session-move/move-ledger.ts";
import type { MoveId } from "../../core/session-move/ownership.ts";
import type { RpcMoveLanded, RpcMoveRecord } from "./session-move-wire.ts";

function wireLanded(landed: LandedFile | undefined): RpcMoveLanded | undefined {
	if (landed === undefined) return undefined;
	if (landed === "gone") return { landed_file: "gone" };
	return { session_path: landed.sessionPath, session_id: landed.sessionId, cwd: landed.cwd };
}

/** The `status` answer: the receiver's record, and beside `accepted` where the move landed. */
export async function statusAnswer(
	ledger: MoveLedger,
	moveId: MoveId,
	sessionPath: string | undefined,
): Promise<RpcMoveRecord> {
	const { answer, landed } = await answerMoveStatusAndLanding(ledger, moveId, sessionPath);
	return answer.state === "accepted" ? { ...answer, ...wireLanded(landed) } : answer;
}

/**
 * What a refusal's `errorData` gains when an import was fenced because its move already landed here: where it landed,
 * and `revoked: true` when that copy was sealed, so a caller learns that binding it would answer `session_moved_away`.
 */
export async function landedWhenFenced(
	ledger: MoveLedger,
	cause: unknown,
): Promise<(RpcMoveLanded & { revoked?: true }) | undefined> {
	if (!(cause instanceof MoveFencedError) || cause.record?.state !== "accepted") return undefined;
	const { answer, landed } = await answerMoveStatusAndLanding(ledger, cause.moveId, undefined);
	const where = wireLanded(landed);
	if (where === undefined) return undefined;
	return "revoked" in answer ? { ...where, revoked: true } : where;
}
