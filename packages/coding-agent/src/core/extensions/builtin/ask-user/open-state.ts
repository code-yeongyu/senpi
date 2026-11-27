import type { ExtensionAPI } from "../../types.ts";
import { WAKE_SOURCE_STATE_EVENT, type WakeSourceStateEvent } from "../monitor-state-event.ts";
import type { QuestionRequest } from "./pending.ts";
import { getPendingQuestions } from "./registry.ts";

/** The `ask-user` wake source: this session's pending questions that do not hold the turn. */
export function emitWake(pi: Pick<ExtensionAPI, "events">, sessionId: string): void {
	const entries = getPendingQuestions(sessionId).filter((e) => !e.request.waitForAnswer);
	const event: WakeSourceStateEvent = {
		source: "ask-user",
		activeCount: entries.length,
		items: entries.map((e) => ({
			id: e.request.requestId,
			deadlineAtMs: e.pending.deadlineAtMs,
			description: e.request.questions.map((q) => q.header).join(", "),
		})),
	};
	pi.events.emit(WAKE_SOURCE_STATE_EVENT, event);
}

/** The block an open question puts on the session, for the pane report and the session's liveness. */
export function emitQuestionBlocked(pi: Pick<ExtensionAPI, "events">, request: QuestionRequest): void {
	const first = request.questions[0];
	pi.events.emit("herdr:blocked", {
		active: true,
		label: first ? `${first.header} - ${first.question}` : "Question",
		id: request.requestId,
		kind: "question",
	});
}
