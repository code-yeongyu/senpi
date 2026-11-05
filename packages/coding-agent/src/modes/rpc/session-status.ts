/**
 * The `session_status` record and the ONE pure function that derives it.
 *
 * Every status a subscriber sees - the snapshot in the `subscribe_sessions` answer and every delta after
 * it - is computed by `deriveSessionStatus` from three inputs the host already holds: the registry entry
 * (lifecycle state, attachments, identity), the session's own runtime view (streaming, compacting, model,
 * queues, pending questions) and the fanout's pending question frames. Nothing here reads a clock, a
 * socket or a registry, so the derivation table is pinned by unit tests rather than by timing.
 */
import type { SessionKind } from "../../core/extensions/types.ts";
import type { RpcSessionState } from "./session-registry-types.ts";

export type SessionStatusValue =
	| "opening"
	| "idle"
	| "running"
	| "waiting_input"
	| "compacting"
	| "unloaded"
	| "closed";

export type SessionStatusCause =
	| "open"
	| "prompt"
	| "agent_end"
	| "agent_idle"
	| "abort"
	| "question"
	| "compaction"
	| "set_model"
	| "queue"
	| "attach"
	| "detach"
	| "replace"
	| "park"
	| "close"
	| "context";

export type SessionStatusActor = "client" | "agent" | "host";

/** A session's published labels: the open-time context overlaid with every `set_session_context` patch. */
export type PublishedSessionContext = Readonly<Record<string, string | number | boolean>>;

/** Why a session's routing handle ended; set once, from the record that sealed it. */
export interface SessionStatusTerminal {
	readonly status: "unloaded" | "closed";
	readonly reason?: string;
}

/** What the registry entry contributes. */
export interface SessionStatusEntryView {
	readonly state: RpcSessionState;
	readonly kind: SessionKind;
	readonly cwd: string;
	readonly attachments: number;
	readonly durableSessionId?: string;
	readonly sessionPath?: string;
	readonly name?: string;
	readonly context: PublishedSessionContext;
	/**
	 * The context the session was opened with, before any `set_session_context` patch. `childrenOf`
	 * subscription matching reads this, so a patch can never move a session into or out of a
	 * supervisor's children view; the published `context` above is what subscribers read.
	 */
	readonly openContext?: PublishedSessionContext;
}

/** What the live runtime contributes; absent while the session is opening or after it was torn down. */
export interface SessionStatusRuntimeView {
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly model?: { readonly provider: string; readonly id: string };
	readonly thinkingLevel?: string;
	readonly steering: number;
	readonly followUp: number;
	readonly pendingQuestions: number;
}

/** The fanout's pending `question` frames for the session (replayed on attach); undefined when the count is unknown. */
export interface SessionStatusFanoutView {
	readonly pendingQuestions: number | undefined;
}

/** The derived half of a `session_status` record: everything except subscription, sequence and change. */
export interface DerivedSessionStatus {
	readonly status: SessionStatusValue;
	readonly reason?: string;
	readonly kind: SessionKind;
	readonly cwd: string;
	readonly attachments: number;
	readonly durableSessionId?: string;
	readonly sessionPath?: string;
	readonly name?: string;
	readonly model?: { readonly provider: string; readonly id: string };
	readonly thinkingLevel?: string;
	readonly pendingQueue: { readonly steering: number; readonly followUp: number };
	readonly context: PublishedSessionContext;
}

/** The state an effect ledger reports for a session's most recent effect (filled by a later provider). */
export interface SessionStatusLastEffect {
	readonly effectId: string;
	readonly kind: string;
	readonly state: string;
}

/** One `session_status` record as it travels on the wire. */
export interface SessionStatusRecord {
	readonly type: "session_status";
	readonly subscriptionId: string;
	readonly seq: number;
	readonly sessionId: string;
	readonly durableSessionId?: string;
	readonly sessionPath?: string;
	readonly kind: SessionKind;
	readonly cwd: string;
	readonly name?: string;
	readonly status: SessionStatusValue;
	readonly reason?: string;
	readonly attachments: number;
	readonly model?: { readonly provider: string; readonly id: string };
	readonly thinkingLevel?: string;
	readonly pendingQueue: { readonly steering: number; readonly followUp: number };
	readonly context?: PublishedSessionContext;
	readonly lastEffect?: SessionStatusLastEffect;
	readonly lastChange: { readonly at: string; readonly cause: SessionStatusCause; readonly by: SessionStatusActor };
}

function liveStatus(runtime: SessionStatusRuntimeView, fanout: SessionStatusFanoutView): SessionStatusValue {
	// A question is asked from inside a running turn, and compaction can run inside one too: the narrower
	// state wins, so a supervisor sees "waiting on the user" rather than a turn that merely looks busy.
	// An unknown fanout count is no evidence either way: the runtime's own count decides.
	if ((fanout.pendingQuestions ?? 0) > 0 || runtime.pendingQuestions > 0) return "waiting_input";
	if (runtime.isCompacting) return "compacting";
	if (runtime.isStreaming) return "running";
	return "idle";
}

function statusOf(
	entry: SessionStatusEntryView,
	runtime: SessionStatusRuntimeView | undefined,
	fanout: SessionStatusFanoutView,
	terminal: SessionStatusTerminal | undefined,
): SessionStatusValue {
	if (terminal !== undefined) return terminal.status;
	switch (entry.state) {
		case "opening":
			return "opening";
		case "closing":
		case "quarantined":
		case "closed":
			return "closed";
		case "open":
			return runtime === undefined ? "opening" : liveStatus(runtime, fanout);
		default: {
			const exhaustive: never = entry.state;
			throw new Error(`unexpected session state ${String(exhaustive)}`);
		}
	}
}

/**
 * Derive a session's status. `terminal` is the seal the writer recorded (park, close, release); `cause`
 * is the change being published, used only for the `reason` of a run that an abort ended.
 */
export function deriveSessionStatus(
	entry: SessionStatusEntryView,
	runtime: SessionStatusRuntimeView | undefined,
	fanout: SessionStatusFanoutView,
	terminal?: SessionStatusTerminal,
	cause?: SessionStatusCause,
): DerivedSessionStatus {
	const status = statusOf(entry, runtime, fanout, terminal);
	const reason = terminal?.reason ?? (status === "idle" && cause === "abort" ? "aborted" : undefined);
	return {
		status,
		...(reason !== undefined ? { reason } : {}),
		kind: entry.kind,
		cwd: entry.cwd,
		attachments: Math.max(0, entry.attachments),
		...(entry.durableSessionId !== undefined ? { durableSessionId: entry.durableSessionId } : {}),
		...(entry.sessionPath !== undefined ? { sessionPath: entry.sessionPath } : {}),
		...(entry.name !== undefined ? { name: entry.name } : {}),
		...(runtime?.model !== undefined ? { model: { provider: runtime.model.provider, id: runtime.model.id } } : {}),
		...(runtime?.thinkingLevel !== undefined ? { thinkingLevel: runtime.thinkingLevel } : {}),
		pendingQueue: { steering: runtime?.steering ?? 0, followUp: runtime?.followUp ?? 0 },
		context: entry.context,
	};
}

/**
 * The terminal a lifecycle record seals a session with. A park and a handoff park leave a session that
 * reopens by path (`unloaded`); every other close ends it (`closed`) with today's `session_closed.reason`.
 */
export function terminalOfLifecycle(record: {
	readonly type: string;
	readonly reason?: unknown;
}): SessionStatusTerminal | undefined {
	const reason = typeof record.reason === "string" ? record.reason : undefined;
	if (record.type === "session_parked")
		return { status: "unloaded", reason: reason === "unloaded" ? "unload_session" : "idle" };
	if (record.type !== "session_closed") return undefined;
	if (reason === "handoff_parked") return { status: "unloaded", reason: "handoff" };
	return reason === undefined ? { status: "closed" } : { status: "closed", reason };
}

/** The status change a session record publishes, or undefined when the record changes no status. */
export function causeOfRecord(record: {
	readonly type?: unknown;
	readonly method?: unknown;
}): SessionStatusCause | undefined {
	switch (record.type) {
		case "agent_start":
			return "prompt";
		case "agent_end":
			return "agent_end";
		case "agent_idle":
			return "agent_idle";
		case "session_abort":
			return "abort";
		case "queue_update":
			return "queue";
		case "model_changed":
		case "thinking_level_changed":
			return "set_model";
		case "session_replaced":
			return "replace";
		case "session_parked":
			return "park";
		case "session_closed":
			return "close";
		case "question_resolved":
			return "question";
		case "extension_ui_request":
			return record.method === "question" ? "question" : undefined;
		case "compaction_start":
		case "compaction_end":
			return "compaction";
		default:
			return undefined;
	}
}
