/**
 * When a hosted session may change writers: the ONE quiet check `release_session` and a handoff drain
 * judge a session by (code-yeongyu/oh-my-openagent#10091, strict session transfer).
 *
 * Quiet needs positive proof. A session is quiet only when every signal it publishes was read and
 * none of them reports work: no run, no prompt in preflight, no queued input still owed a turn, no
 * admitted delivery waiting to be written, no bash, compaction or barrier-held session work, and no
 * other request for it in flight. A signal that is missing or that throws is `unknown`: such a session
 * stays with its owner, where its work (if any) keeps running, instead of being handed to a successor
 * that would become its second writer.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { isHandoffBusy } from "./handoff-activity.ts";
import type { RpcSessionEntry } from "./session-registry-types.ts";

/** What keeps a session with its current writer. `unknown`: its activity could not be read. */
export type TransferBlocker =
	| "turn"
	| "prompt"
	| "queued"
	| "delivery"
	| "bash"
	| "compaction"
	| "session_work"
	| "activity"
	| "request"
	| "unknown";

/** The blockers an in-process session can report; the wire names `release_session` answers with. */
export type SessionBusySignal = Exclude<TransferBlocker, "unknown">;

export type QuietCheckSession = Pick<AgentSession, "activitySnapshot" | "pendingMessageCount" | "externalAdmission">;

/** Every signal that keeps `session` busy; empty when it is quiet. A throwing signal propagates. */
export function sessionBusySignals(
	session: QuietCheckSession,
	pendingPrompts: number,
	otherRequests: number,
): SessionBusySignal[] {
	const activity = session.activitySnapshot;
	const signals: SessionBusySignal[] = [];
	if (activity.isStreaming) signals.push("turn");
	if (pendingPrompts > 0) signals.push("prompt");
	// Queued user input outlives its run (a steer can end the stream it was aimed at): it is still owed a turn.
	if (session.pendingMessageCount > 0) signals.push("queued");
	if (session.externalAdmission.list().pending.length > 0) signals.push("delivery");
	if (activity.isBashRunning) signals.push("bash");
	if (activity.isCompacting) signals.push("compaction");
	if (activity.hasSessionWork) signals.push("session_work");
	// The handoff predicate decides; a source added to it later is not missed here.
	if (signals.length === 0 && isHandoffBusy(activity)) signals.push("activity");
	if (otherRequests > 0) signals.push("request");
	return signals;
}

/**
 * A hosted entry's blockers. An in-process runtime is judged by `sessionBusySignals`; a worker isolate by
 * the activity it last reported (a worker that has reported none is `unknown`). An entry with neither, or
 * whose signals throw, is `unknown`, never quiet.
 */
export function entryTransferBlockers(
	entry: Pick<RpcSessionEntry, "runtime" | "worker">,
	pendingPrompts: () => number,
	otherRequests: number,
): readonly TransferBlocker[] {
	try {
		const session = entry.runtime?.session;
		if (session !== undefined) return sessionBusySignals(session, pendingPrompts(), otherRequests);
		const worker = entry.worker;
		if (worker?.snapshot === undefined) return ["unknown"];
		if (worker.handoffBusy) return ["activity"];
		return otherRequests > 0 ? ["request"] : [];
	} catch {
		// Any throw while reading a signal is the same verdict as a missing one: the session is not proven quiet.
		return ["unknown"];
	}
}
