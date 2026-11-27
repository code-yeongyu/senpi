/**
 * Projects a registry entry into the views `deriveSessionStatus` reads. An in-process entry is read from
 * its live `AgentSession`; a worker-isolate entry from the last state snapshot its worker published.
 * Identity is read from the runtime first, because a `new_session`/`switch_session` moves the durable id
 * and file before the registry's own metadata sync runs.
 */
import { isSessionArchived } from "../../core/session-archived.ts";
import { redactedRetryWait } from "../../core/retry-wait.ts";
import { readSessionSettled, type SettledFields, settledFields } from "../../core/session-settled.ts";
import { sessionQuestionBridges } from "./connection-question-bridge.ts";
import { sessionRowHold } from "./session-row-hold.ts";
import { publishedSessionContext } from "./session-context-patch.ts";
import type { RpcSessionEntry, RpcSessionRow } from "./session-registry-types.ts";
import type { SessionStatusEntryView, SessionStatusRuntimeView } from "./session-status.ts";
import type { SessionStatusSource } from "./session-status-stream.ts";

function modelOf(model: { readonly provider: string; readonly id: string } | undefined) {
	return model === undefined ? undefined : { provider: model.provider, id: model.id };
}

type LiveSession = NonNullable<NonNullable<RpcSessionEntry["runtime"]>["session"]>;

export function liveRowHold(session: LiveSession) {
	return sessionRowHold(session.holds ?? [], () => session.externalAdmission.list().pending.length);
}

/** What a live in-process session contributes; `pendingQuestions` defaults to its RPC question bridge. */
export function sessionRuntimeView(session: LiveSession, pendingQuestions?: number): SessionStatusRuntimeView {
	const model = modelOf(session.model);
	const hold = liveRowHold(session);
	return {
		...(hold && { hold }),
		isStreaming: session.isStreaming === true,
		isCompacting: session.isCompacting === true,
		...(model !== undefined ? { model } : {}),
		...(session.thinkingLevel !== undefined ? { thinkingLevel: session.thinkingLevel } : {}),
		steering: typeof session.getSteeringMessages === "function" ? session.getSteeringMessages().length : 0,
		followUp: typeof session.getFollowUpMessages === "function" ? session.getFollowUpMessages().length : 0,
		pendingQuestions: pendingQuestions ?? sessionQuestionBridges.get(session)?.pendingQuestions()?.length ?? 0,
		...(session.retryWait === undefined ? {} : { waiting: session.retryWait }),
	};
}

function runtimeView(entry: RpcSessionEntry): SessionStatusRuntimeView | undefined {
	const session = entry.runtime?.session;
	if (session !== undefined) return sessionRuntimeView(session);
	const state = entry.worker?.snapshot?.state;
	if (state === undefined) return undefined;
	const model = modelOf(state.model ?? undefined);
	return {
		...(entry.worker?.snapshot?.hold && { hold: entry.worker.snapshot.hold }),
		isStreaming: state.isStreaming,
		isCompacting: state.isCompacting,
		...(model !== undefined ? { model } : {}),
		...(state.thinkingLevel !== undefined ? { thinkingLevel: state.thinkingLevel } : {}),
		steering: state.steering.length,
		followUp: state.followUp.length,
		pendingQuestions: state.pendingQuestions?.length ?? 0,
		...(state.retryWait === undefined ? {} : { waiting: state.retryWait }),
	};
}

/** The Done flag, read from the live session or the worker's last snapshot; undefined before either exists. */
function settledOf(entry: RpcSessionEntry): SettledFields | undefined {
	const session = entry.runtime?.session;
	if (session !== undefined) return settledFields(readSessionSettled(session.sessionManager));
	const snapshot = entry.worker?.snapshot;
	if (snapshot === undefined) return undefined;
	const { settled, settledBy } = snapshot;
	return settledBy !== undefined ? { settled, settledBy } : { settled };
}

function entryView(entry: RpcSessionEntry): SessionStatusEntryView {
	const session = entry.runtime?.session;
	const state = entry.worker?.snapshot?.state;
	const durableSessionId = session?.sessionId ?? state?.sessionId ?? entry.durableSessionId;
	const sessionPath = session?.sessionFile ?? state?.sessionFile ?? entry.sessionPath;
	const name = session?.sessionManager.getSessionName() ?? state?.sessionName;
	const archived =
		session !== undefined ? isSessionArchived(session.sessionManager) : entry.worker?.snapshot?.archived;
	const settled = settledOf(entry);
	return {
		state: entry.state,
		kind: entry.kind,
		cwd: entry.cwd,
		attachments: entry.attachments,
		lastActivityAt: entry.lastCommandAt,
		...(durableSessionId !== undefined ? { durableSessionId } : {}),
		...(sessionPath !== undefined ? { sessionPath } : {}),
		...(name !== undefined ? { name } : {}),
		...(archived !== undefined ? { archived } : {}),
		...(settled !== undefined ? { settled } : {}),
		context: publishedSessionContext(entry.context, entry.contextOverlay),
		openContext: entry.context,
	};
}

/**
 * The `list_sessions` row fields, read from the same sources a `session_status` row is derived from. A row shows
 * only whether a turn runs, its retry wait and the model, so it reads those and never the queue or question counts.
 * The wait is redacted: a listing reaches every connection that can list sessions, so it carries the typed kind
 * and its timing but never the provider's error text, which stays on `get_state` and on `session_status`.
 */
function activityFields(
	entry: RpcSessionEntry,
): Pick<RpcSessionRow, "archived" | "settled" | "settledBy" | "activity" | "waiting" | "model"> {
	const session = entry.runtime?.session;
	const state = entry.worker?.snapshot?.state;
	const streaming = session !== undefined ? session.isStreaming === true : state?.isStreaming === true;
	const model = modelOf(session !== undefined ? session.model : (state?.model ?? undefined));
	const wait = streaming ? (session !== undefined ? session.retryWait : state?.retryWait) : undefined;
	const waiting = wait === undefined ? undefined : redactedRetryWait(wait);
	return {
		archived: entryView(entry).archived === true,
		...(settledOf(entry) ?? { settled: false }),
		activity: streaming ? "running" : "idle",
		...(waiting === undefined ? {} : { waiting }),
		...(model !== undefined ? { model } : {}),
	};
}

export function sessionRowStatusFields(entry: RpcSessionEntry) {
	const session = entry.runtime?.session;
	const hold = session ? liveRowHold(session) : entry.worker?.snapshot?.hold;
	return { ...activityFields(entry), ...(hold && { hold }) };
}

export function registryStatusSource(registry: {
	readonly peek: (sessionId: string) => RpcSessionEntry | undefined;
	readonly list: () => readonly { readonly sessionId: string }[];
}): SessionStatusSource {
	return {
		sessionIds: () => registry.list().map((row) => row.sessionId),
		entryView: (sessionId) => {
			const entry = registry.peek(sessionId);
			return entry === undefined || entry.speculative ? undefined : entryView(entry);
		},
		view: (sessionId) => {
			const entry = registry.peek(sessionId);
			if (entry === undefined || entry.speculative) return undefined;
			const runtime = runtimeView(entry);
			return runtime === undefined ? { entry: entryView(entry) } : { entry: entryView(entry), runtime };
		},
	};
}
