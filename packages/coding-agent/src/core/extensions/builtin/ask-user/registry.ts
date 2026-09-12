import type { ExtensionUIDialogOptions } from "../../types.ts";
import type { PendingQuestion } from "./pending.ts";
import type { QuestionRequest, QuestionResponse } from "./schema.ts";

/** Additive options consumed by question-capable UI bridges. Delivery belongs to the UI. */
export interface QuestionDialogOptions extends ExtensionUIDialogOptions {
	deliver: "tool-result" | "user-message";
	hardDeadlineAtMs: number;
	onProgress: (draft: { answers?: QuestionResponse["answers"]; comment?: string }) => void;
}
export interface PendingQuestionEntry {
	request: QuestionRequest;
	pending: PendingQuestion;
	completion: Promise<QuestionResponse>;
	cancel(message?: string): void;
}
const sessions = new Map<string, Map<string, PendingQuestionEntry>>();
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
