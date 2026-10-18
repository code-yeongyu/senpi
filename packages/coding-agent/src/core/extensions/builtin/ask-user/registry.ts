import type { ExtensionAPI, ExtensionContext, ExtensionUIDialogOptions } from "../../types.ts";
import type { PendingQuestion } from "./pending.ts";
import type { QuestionRequest, QuestionResponse } from "./schema.ts";
import type { AskUserState } from "./tool.ts";

/** Additive options consumed by question-capable UI bridges. Delivery belongs to the UI. */
export interface QuestionDialogOptions extends ExtensionUIDialogOptions {
	deliver: "tool-result" | "user-message";
	hardDeadlineAtMs: number;
	/** Live absolute idle deadline; question UI countdowns are display-only when supplied. */
	getDeadlineAtMs?: () => number;
	initialDraft?: { answers: QuestionResponse["answers"]; comment?: string };
	onProgress: (draft: { answers?: QuestionResponse["answers"]; comment?: string }) => void;
}
export interface PendingQuestionEntry {
	request: QuestionRequest;
	pending: PendingQuestion;
	completion: Promise<QuestionResponse>;
	cancel(message?: string, reportDetachedLoss?: boolean): void;
	detach(): void;
	rebind(pi: ExtensionAPI, ctx: ExtensionContext, state: AskUserState): void;
	reattach(): void;
}
const sessions = new Map<string, Map<string, PendingQuestionEntry>>();
type QueuedOutcome = (pi: ExtensionAPI, ctx: ExtensionContext) => void;
const outcomes = new Map<string, QueuedOutcome[]>();

/** A terminal request awaiting a live runner is no longer a pending question. */
export function queueQuestionOutcome(sessionId: string, outcome: QueuedOutcome): void {
	const queued = outcomes.get(sessionId) ?? [];
	queued.push(outcome);
	outcomes.set(sessionId, queued);
}

export function deliverQueuedQuestionOutcomes(sessionId: string, pi: ExtensionAPI, ctx: ExtensionContext): void {
	const queued = outcomes.get(sessionId) ?? [];
	outcomes.delete(sessionId);
	for (const outcome of queued) outcome(pi, ctx);
}
export function getPendingQuestions(sessionId: string): readonly PendingQuestionEntry[] {
	return [...(sessions.get(sessionId)?.values() ?? [])];
}
export function registerPendingQuestion(sessionId: string, entry: PendingQuestionEntry): () => void {
	let entries = sessions.get(sessionId);
	if (!entries) {
		entries = new Map();
		sessions.set(sessionId, entries);
	}
	entries.set(entry.request.requestId, entry);
	return () => {
		if (entries.get(entry.request.requestId) !== entry) return;
		entries.delete(entry.request.requestId);
		if (entries.size === 0) sessions.delete(sessionId);
	};
}
