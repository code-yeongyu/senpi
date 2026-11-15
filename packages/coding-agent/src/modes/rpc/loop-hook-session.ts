/**
 * The loop session a hand's call sees, read-only (`ctx.sessionManager`), bound to that call only: the session's id and
 * what the loop carried, never its transcript path; everything else is loop-side.
 */
import { join } from "node:path";
import type { HistoryReducer } from "../../core/session-history-reduce.ts";
import type { ReadonlySessionManager } from "../../core/session-manager.ts";
import type { LoopHookCallBinding } from "./loop-hook-call.ts";

/**
 * The refusal of what a call bound to itself, used from a kept reference after the call ended. A call ends when its
 * reply is built (`effectsReply`), before its own cleanup runs. After that these throw it instead of answering or
 * collecting a write no reply would carry:
 * - the loop session's identity (`getSessionId`, `getSessionFile`, `getCwd`) and the rest of `ctx.sessionManager`,
 *   except that the session the call carried (`getLeafId`, `reduceHistory`) stays readable by the call's own work (its
 *   async context: a Stop it held for background work);
 * - the wake port's `arm` and `cancel` (`pi.session.sessionWakes()`);
 * - the relocation host's `request` (`pi.session.requestRelocation`);
 * - `pi.setActiveTools` (its change is relative to the active set the call carried);
 * - `ctx.hasPendingMessages`, `pi.getActiveTools` and `ctx.getSystemPromptOptions`, except from the call's own work.
 * The rest keeps working: late messages, notices, entries and user messages go to the call's late route; the signal stays
 * aborted; idle keeps its value, except that after a call that ended the loop's turn it answers idle until the loop
 * starts another call.
 */
export class LoopHookCallEndedError extends Error {
	override readonly name = "LoopHookCallEndedError";
	/** The member that was read, e.g. `sessionManager.getSessionId`. */
	readonly member: string;
	constructor(member: string) {
		super(`this loop-hook call has ended; ${member} is bound to that call only`);
		this.member = member;
	}
}

export function readOnlySession(
	{ sessionId, cwd, carried }: LoopHookCallBinding,
	sessionDir: string | undefined,
	gates: { readonly live: () => boolean; readonly ownWork: () => boolean },
): ReadonlySessionManager {
	const gated =
		(open: () => boolean) =>
		<T>(member: string, read: () => T) =>
		(): T => {
			if (!open()) throw new LoopHookCallEndedError(`sessionManager.${member}`);
			return read();
		};
	const header = carried?.header;
	const bound = gated(gates.live);
	const durable = gated(gates.ownWork);
	const unbound = (member: string) => (): never => {
		throw new Error(
			`sessionManager.${member} is loop-side: a loop-hook call on a hand carries only the session's id`,
		);
	};
	return Object.freeze({
		getSessionId: bound("getSessionId", () => sessionId),
		// With carried documents the call's session has a directory here, and so a file in it (never written): extensions
		// that key their stores by a persisted session's directory (goal, /loop) then keep them with the session's documents.
		getSessionFile: bound("getSessionFile", (): string | undefined =>
			sessionDir === undefined ? undefined : join(sessionDir, `${sessionId}.jsonl`),
		),
		getCwd: bound("getCwd", () => cwd),
		// The session's documents, when the loop carried them; otherwise the session has no directory here (as in memory).
		getSessionDir: carried === undefined ? unbound("getSessionDir") : bound("getSessionDir", () => sessionDir ?? ""),
		getLeafId: carried === undefined ? unbound("getLeafId") : durable("getLeafId", () => carried.leafId),
		getLeafEntry: unbound("getLeafEntry"),
		getEntry: unbound("getEntry"),
		getLabel: unbound("getLabel"),
		getBranch:
			carried === undefined
				? unbound("getBranch")
				: bound("getBranch", () => [...(carried.branch ?? carried.handEntries)]),
		getFullBranch: unbound("getFullBranch"),
		buildContextEntries: unbound("buildContextEntries"),
		buildSessionContext: unbound("buildSessionContext"),
		buildSessionProjection: unbound("buildSessionProjection"),
		getHeader: header === undefined ? unbound("getHeader") : bound("getHeader", () => ({ ...header })),
		getEntries:
			carried === undefined
				? unbound("getEntries")
				: bound("getEntries", () => [...(carried.branch ?? carried.handEntries)]),
		reduceHistory:
			carried === undefined
				? unbound("reduceHistory")
				: <T>(reducer: HistoryReducer<T>): T =>
						durable("reduceHistory", () => carried.handEntries.reduce(reducer.add, reducer.initial()))(),
		getTree: unbound("getTree"),
		getSessionName: unbound("getSessionName"),
	});
}
