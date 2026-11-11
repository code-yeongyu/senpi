/**
 * What makes a session too busy to hand over: the signals a release reads, the refusal code they map to, and the
 * data that refusal carries. `isStreaming` alone is not enough - a user bash and a prompt in preflight both write
 * after it - so every source the handoff park judges by is read here.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { isHandoffBusy } from "./handoff-activity.ts";
import { RPC_ERROR_SESSION_BUSY, RPC_ERROR_TURN_ACTIVE } from "./rpc-types.ts";

/** `errorData.hint` of a refusal whose `busy` names `queued`: only an interrupt hands that input back. */
export const RELEASE_QUEUED_HINT =
	"queued user input is still owed a turn; release with interrupt: true to take it out and receive it in dropped.user_messages";

export type ReleaseBusySignal =
	| "turn"
	| "prompt"
	| "queued"
	| "delivery"
	| "bash"
	| "compaction"
	| "session_work"
	| "activity"
	| "request";

/** What the busy check needs of the router: the prompts in preflight and the session's other requests in flight. */
export interface ReleaseBusyPort {
	pendingPrompts(sessionId: string): readonly unknown[];
	otherRequests(sessionId: string): number;
}

export function busySignals(port: ReleaseBusyPort, sessionId: string, session: AgentSession): ReleaseBusySignal[] {
	const activity = session.activitySnapshot;
	const signals: ReleaseBusySignal[] = [];
	if (activity.isStreaming) signals.push("turn");
	if (port.pendingPrompts(sessionId).length > 0) signals.push("prompt");
	// Queued user input outlives its run (a steer can end the stream it was aimed at): it is still owed a turn.
	if (session.pendingMessageCount > 0) signals.push("queued");
	if (session.externalAdmission.list().pending.length > 0) signals.push("delivery");
	if (activity.isBashRunning) signals.push("bash");
	if (activity.isCompacting) signals.push("compaction");
	if (activity.hasSessionWork) signals.push("session_work");
	// The handoff park's predicate decides; a source added to it later is not missed here.
	if (signals.length === 0 && isHandoffBusy(activity)) signals.push("activity");
	if (port.otherRequests(sessionId) > 0) signals.push("request");
	return signals;
}

export function busyData(signals: readonly ReleaseBusySignal[]): Readonly<Record<string, unknown>> {
	return signals.includes("queued")
		? { busy: signals, retry_with: { interrupt: true }, hint: RELEASE_QUEUED_HINT }
		: { busy: signals };
}

export function busyCode(signals: readonly ReleaseBusySignal[]): string {
	return signals.some(
		(signal) => signal === "turn" || signal === "prompt" || signal === "queued" || signal === "delivery",
	)
		? RPC_ERROR_TURN_ACTIVE
		: RPC_ERROR_SESSION_BUSY;
}
