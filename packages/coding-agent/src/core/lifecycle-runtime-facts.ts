import { sessionQuestionBridges } from "../modes/rpc/connection-question-bridge.ts";
import { sessionDialogRequests } from "../modes/rpc/session-extension-ui-requests.ts";
import type { AgentSession } from "./agent-session.ts";
import type { LifecycleRuntimeFacts } from "./session-lifecycle.ts";
import type { HumanWait, LifecycleHold } from "./session-lifecycle-types.ts";

const dialogOpenedAt = new WeakMap<AgentSession, Map<string, string>>();

/** Reads the same live registries used by get_state, including attention under holds. */
export function readLifecycleRuntimeFacts(session: AgentSession): LifecycleRuntimeFacts {
	const now = new Date().toISOString();
	const human: HumanWait[] = [];
	const tuiWait = session.extensionRunner.getLifecycleHumanWait?.();
	if (tuiWait) human.push({ ...tuiWait, originSessionId: session.sessionId });
	const dialogs = sessionDialogRequests.get(session)?.snapshot() ?? [];
	const opened = dialogOpenedAt.get(session) ?? new Map<string, string>();
	dialogOpenedAt.set(session, opened);
	for (const id of opened.keys()) if (!dialogs.some((dialog) => dialog.id === id)) opened.delete(id);
	for (const question of sessionQuestionBridges.get(session)?.pendingQuestions() ?? []) {
		human.push({
			kind: "question",
			originSessionId: session.sessionId,
			requestId: question.requestId,
			revision: 1,
			since: new Date(question.askedAtMs).toISOString(),
		});
	}
	for (const dialog of dialogs) {
		if (!opened.has(dialog.id)) opened.set(dialog.id, now);
		human.push({
			kind: dialog.method === "confirm" ? "approval" : "question",
			originSessionId: session.sessionId,
			requestId: dialog.id,
			revision: 1,
			since: opened.get(dialog.id) ?? now,
		});
	}
	const holds: LifecycleHold[] = session.holds.flatMap((hold) => {
		// The interruption gate is a human wait, not a user Stop. Preserve unattended and real Stop precedence.
		if (hold.kind === "session_hold" && hold.key === "interrupted-run") return [];
		switch (hold.kind) {
			case "unattended":
			case "session_hold":
			case "run_fence":
			case "inherited_hold":
				return [{ kind: hold.kind, since: hold.since }];
			default:
				return [];
		}
	});
	return {
		activity: session.activitySnapshot,
		pendingMessages: session.pendingMessageCount,
		holds,
		human,
		inputAdmissionPending: session.externalAdmission.hasInputWork,
	};
}
