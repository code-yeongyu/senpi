/**
 * The `move_session` answers that say where an accepted move landed (senpi#6436): `status`, and a `move_fenced`
 * refusal of a move already accepted here. Whoever may send the import may ask; nothing is opened, held or rewritten
 * for it. A `status` may also name the place the move would have landed, and is then answered from the file there
 * first.
 */
import { join } from "node:path";
import { getDefaultSessionDirPath } from "../../core/session-manager.ts";
import { answerMoveStatusAndLanding, type StatusFile } from "../../core/session-move/import.ts";
import type { LandedFile } from "../../core/session-move/landed-file.ts";
import { MoveFencedError, type MoveLedger } from "../../core/session-move/move-ledger.ts";
import type { MoveId } from "../../core/session-move/ownership.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { StatusNamedFile } from "./session-move-request.ts";
import type { RpcMoveLanded, RpcMoveRecord } from "./session-move-wire.ts";

function wireLanded(landed: LandedFile | undefined): RpcMoveLanded | undefined {
	if (landed === undefined) return undefined;
	if (landed === "gone") return { landed_file: "gone" };
	const { ownership } = landed;
	const where = { session_path: landed.sessionPath, session_id: landed.sessionId, cwd: landed.cwd };
	if (ownership.writable) return { ...where, writable: true };
	const sealed_by = { move_id: ownership.moveId, state: ownership.state, target: ownership.target };
	return { ...where, writable: false, sealed_by };
}

/**
 * The session file a `status` asks about. A `landing` is resolved by the rules `import` lands a session by, from the
 * same three values, so the two name one path; and without making the session folder, so a question leaves nothing
 * behind.
 */
export function statusFile(named: StatusNamedFile | undefined, agentDir: string): StatusFile | undefined {
	if (named === undefined) return undefined;
	switch (named.kind) {
		case "path":
			return { file: named.sessionPath, as: "copy" };
		case "landing": {
			const sessionDir =
				named.sessionDir === undefined
					? getDefaultSessionDirPath(resolvePath(named.cwd), agentDir)
					: normalizePath(named.sessionDir);
			return { file: join(sessionDir, named.sessionFileName), as: "landing" };
		}
	}
}

/** The `status` answer: the receiver's record, and beside `accepted` where the move landed. */
export async function statusAnswer(
	ledger: MoveLedger,
	moveId: MoveId,
	asked: StatusFile | undefined,
): Promise<RpcMoveRecord> {
	const { answer, landed } = await answerMoveStatusAndLanding(ledger, moveId, asked);
	return answer.state === "accepted" ? { ...answer, ...wireLanded(landed) } : answer;
}

/**
 * What a `move_fenced` refusal's `errorData` gains when the move it refuses is already accepted here, whichever op
 * was refused (an `import` into another folder, a `prepare` for another folder): where the move landed, and
 * `revoked: true` when that copy was sealed, so a caller learns that binding it would answer `session_moved_away`.
 * It only adds to a refusal: if the record or the landed file cannot be read now, the refusal goes out without it.
 */
export async function landedWhenFenced(
	ledger: MoveLedger,
	cause: unknown,
): Promise<(RpcMoveLanded & { revoked?: true }) | undefined> {
	if (!(cause instanceof MoveFencedError) || cause.record?.state !== "accepted") return undefined;
	const read = await answerMoveStatusAndLanding(ledger, cause.moveId, undefined).catch(() => undefined);
	const where = wireLanded(read?.landed);
	if (read === undefined || where === undefined) return undefined;
	return "revoked" in read.answer ? { ...where, revoked: true } : where;
}
