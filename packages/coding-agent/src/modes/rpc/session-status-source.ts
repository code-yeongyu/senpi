/**
 * Projects a registry entry into the views `deriveSessionStatus` reads. An in-process entry is read from
 * its live `AgentSession`; a worker-isolate entry from the last state snapshot its worker published.
 * Identity is read from the runtime first, because a `new_session`/`switch_session` moves the durable id
 * and file before the registry's own metadata sync runs.
 */
import { providerFailureOf } from "../../core/provider-failure.ts";
import { isSessionArchived } from "../../core/session-archived.ts";
import { sessionQuestionBridges } from "./connection-question-bridge.ts";
import { deriveSessionActivity } from "./session-activity.ts";
import { publishedSessionContext } from "./session-context-patch.ts";
import type { RpcSessionEntry, RpcSessionRow } from "./session-registry-types.ts";
import type { SessionStatusEntryView, SessionStatusRuntimeView } from "./session-status.ts";
import type { SessionStatusSource } from "./session-status-stream.ts";

function modelOf(model: { readonly provider: string; readonly id: string } | undefined) {
	return model === undefined ? undefined : { provider: model.provider, id: model.id };
}

type LiveSession = NonNullable<NonNullable<RpcSessionEntry["runtime"]>["session"]>;

/**
 * The current or most recent turn's id (its admission epoch, the `turnId` a prompt response names) and the failure
 * category `agent_end` reported when the last turn ended with a provider error.
 */
export function sessionTurnView(
	session: Pick<LiveSession, "externalAdmission" | "messages">,
): Pick<SessionStatusRuntimeView, "turnId" | "errorCode"> {
	const epoch = session.externalAdmission.turnEpoch;
	const errorCode = providerFailureOf(session.messages)?.category;
	return {
		...(epoch > 0 ? { turnId: String(epoch) } : {}),
		...(errorCode !== undefined ? { errorCode } : {}),
	};
}

/** What a live in-process session contributes; `pendingQuestions` defaults to its RPC question bridge. */
export function sessionRuntimeView(session: LiveSession, pendingQuestions?: number): SessionStatusRuntimeView {
	const model = modelOf(session.model);
	return {
		isStreaming: session.isStreaming === true,
		isCompacting: session.isCompacting === true,
		...(model !== undefined ? { model } : {}),
		...(session.thinkingLevel !== undefined ? { thinkingLevel: session.thinkingLevel } : {}),
		steering: typeof session.getSteeringMessages === "function" ? session.getSteeringMessages().length : 0,
		followUp: typeof session.getFollowUpMessages === "function" ? session.getFollowUpMessages().length : 0,
		pendingQuestions: pendingQuestions ?? sessionQuestionBridges.get(session)?.pendingQuestions()?.length ?? 0,
		...sessionTurnView(session),
	};
}

function runtimeView(entry: RpcSessionEntry): SessionStatusRuntimeView | undefined {
	const session = entry.runtime?.session;
	if (session !== undefined) return sessionRuntimeView(session);
	const snapshot = entry.worker?.snapshot;
	const state = snapshot?.state;
	if (snapshot === undefined || state === undefined) return undefined;
	const model = modelOf(state.model ?? undefined);
	return {
		isStreaming: state.isStreaming,
		isCompacting: state.isCompacting,
		...(model !== undefined ? { model } : {}),
		...(state.thinkingLevel !== undefined ? { thinkingLevel: state.thinkingLevel } : {}),
		steering: state.steering.length,
		followUp: state.followUp.length,
		pendingQuestions: state.pendingQuestions?.length ?? 0,
		...(snapshot.turnId !== undefined ? { turnId: snapshot.turnId } : {}),
		...(snapshot.errorCode !== undefined ? { errorCode: snapshot.errorCode } : {}),
	};
}

function entryView(entry: RpcSessionEntry): SessionStatusEntryView {
	const session = entry.runtime?.session;
	const state = entry.worker?.snapshot?.state;
	const durableSessionId = session?.sessionId ?? state?.sessionId ?? entry.durableSessionId;
	const sessionPath = session?.sessionFile ?? state?.sessionFile ?? entry.sessionPath;
	const name = session?.sessionManager.getSessionName() ?? state?.sessionName;
	const archived =
		session !== undefined ? isSessionArchived(session.sessionManager) : entry.worker?.snapshot?.archived;
	return {
		state: entry.state,
		kind: entry.kind,
		cwd: entry.cwd,
		attachments: entry.attachments,
		...(durableSessionId !== undefined ? { durableSessionId } : {}),
		...(sessionPath !== undefined ? { sessionPath } : {}),
		...(name !== undefined ? { name } : {}),
		...(archived !== undefined ? { archived } : {}),
		context: publishedSessionContext(entry.context, entry.contextOverlay),
		openContext: entry.context,
	};
}

/** The `list_sessions` row fields read from the same views a `session_status` row is derived from. */
export function sessionRowStatusFields(
	entry: RpcSessionEntry,
): Pick<RpcSessionRow, "archived" | "activity" | "error_code" | "turn_id" | "model"> {
	const runtime = runtimeView(entry);
	return {
		archived: entryView(entry).archived === true,
		...deriveSessionActivity(runtime),
		...(runtime?.model !== undefined ? { model: runtime.model } : {}),
	};
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
