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
import { MoveRecordLockWaitError } from "../../core/session-move/move-ledger-lock.ts";
import type { MoveId } from "../../core/session-move/ownership.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { StatusNamedFile } from "./session-move-request.ts";
import type { RpcMoveLanded, RpcMoveRecord } from "./session-move-wire.ts";

function wireLanded(landed: LandedFile | undefined): RpcMoveLanded | undefined {
	if (landed === undefined) return undefined;
	if (landed === "gone") return { landed_file: "gone" };
	return { session_path: landed.sessionPath, session_id: landed.sessionId, cwd: landed.cwd };
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
 *
 * It only adds to a refusal. When the read of the record and the landed file fails with a file-system error, or
 * because the record's lock stayed taken for the whole wait, the refusal goes out without it. Any other failure of
 * that read is `unexpected`, with its message: the caller is answered that, not the refusal as if nothing were wrong.
 * Either way one line on stderr names the kind and the move, and nothing else.
 */
export async function landedWhenFenced(
	ledger: MoveLedger,
	cause: unknown,
): Promise<{ readonly landed?: RpcMoveLanded & { revoked?: true } } | { readonly unexpected: string }> {
	if (!(cause instanceof MoveFencedError) || cause.record?.state !== "accepted") return {};
	const read = await answerMoveStatusAndLanding(ledger, cause.moveId, undefined).then(
		(value) => ({ value }),
		(failure: unknown) => ({ failure }),
	);
	if ("failure" in read) {
		const kind = landedReadFailureKind(read.failure);
		process.stderr.write(`senpi rpc move_landed_read_failed: kind=${kind} move=${cause.moveId}\n`);
		if (kind !== "unexpected") return {};
		return { unexpected: read.failure instanceof Error ? read.failure.message : String(read.failure) };
	}
	const where = wireLanded(read.value.landed);
	if (where === undefined) return {};
	return { landed: "revoked" in read.value.answer ? { ...where, revoked: true } : where };
}

/** A file-system error is named by its errno code, a record lock that stayed taken `lock_wait`, anything else `unexpected`. */
function landedReadFailureKind(failure: unknown): string {
	if (failure instanceof MoveRecordLockWaitError) return "lock_wait";
	if (typeof failure !== "object" || failure === null || !("errno" in failure) || !("code" in failure))
		return "unexpected";
	const { errno, code } = failure;
	return typeof errno === "number" && typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? code : "unexpected";
}
