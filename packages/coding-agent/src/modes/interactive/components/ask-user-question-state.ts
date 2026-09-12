/**
 * Pure interaction state for the ask-user question overlay.
 *
 * Owns per-question selections, own-answer texts, the active tab, the
 * highlighted row and the response-building rules. Rendering and key decoding
 * live in ask-user-question.ts; this module must stay free of pi-tui imports
 * so the rules are unit-testable headless.
 */

import type { QuestionRequest, QuestionResponse } from "../../../core/extensions/types.ts";

export type QuestionAnswers = QuestionResponse["answers"];
export type QuestionDraft = { answers?: QuestionAnswers; comment?: string };
export type QuestionFocus = "options" | "own-answer" | "submit";

export const COMMENT_LABEL = "Comment (optional; unanswered questions are reported)";
export const OWN_ANSWER_LABEL = "Type your own answer...";
export const NOT_ANSWERED_NOTICE = "You have not answered all questions";
export const DISMISS_NOTICE = "Press Esc again to dismiss (answers will be discarded)";
export const PARTIAL_SUBMIT_NOTICE = "Press Enter again to submit with unanswered questions";

/** Countdown chip label: minutes above five minutes, mm:ss at or below. */
export function formatCountdownLabel(remainingMs: number): string {
	const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
	if (totalSeconds >= 300) return `${Math.ceil(totalSeconds / 60)}m`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export class AskUserQuestionState {
	readonly request: QuestionRequest;
	activeIndex = 0;
	highlightIndex = 0;
	focus: QuestionFocus = "options";
	notice: string | undefined;
	comment: string | undefined;
	private dismissPending = false;
	private readonly selected = new Map<string, string[]>();
	private readonly texts = new Map<string, string>();

	constructor(request: QuestionRequest) {
		this.request = request;
	}

	get activeQuestion(): QuestionRequest["questions"][number] {
		return this.request.questions[this.activeIndex];
	}

	/** Highlightable rows for the active question: options plus the own-answer row. */
	get ownAnswerRowIndex(): number {
		return this.activeQuestion.options.length;
	}

	get rowCount(): number {
		return this.ownAnswerRowIndex + 1;
	}

	get activeTabIndex(): number {
		return this.focus === "submit" ? this.request.questions.length : this.activeIndex;
	}

	switchQuestion(delta: number): void {
		this.switchTab(delta);
	}

	switchTab(delta: number): void {
		const count = this.request.questions.length + 1;
		const next = (this.activeTabIndex + delta + count) % count;
		if (next === this.request.questions.length) {
			this.focus = "submit";
		} else {
			this.focus = "options";
			this.activeIndex = next;
			this.highlightIndex = 0;
		}
		this.dismissPending = false;
		this.notice = undefined;
	}

	advance(): void {
		if (this.activeIndex + 1 < this.request.questions.length) {
			this.activeIndex += 1;
			this.highlightIndex = 0;
			this.notice = undefined;
			this.dismissPending = false;
			return;
		}
		this.focus = "submit";
		this.highlightIndex = 0;
		this.notice = undefined;
		this.dismissPending = false;
	}

	returnToOptions(): void {
		this.focus = "options";
		this.highlightIndex = 0;
		this.notice = undefined;
		this.dismissPending = false;
	}

	requestDismiss(): "confirm" | "cancel" {
		if (!this.hasDraft()) return "cancel";
		if (!this.dismissPending) {
			this.dismissPending = true;
			this.notice = DISMISS_NOTICE;
			return "confirm";
		}
		return "cancel";
	}

	acceptPartialSubmit(): void {
		this.dismissPending = false;
		this.notice = undefined;
	}

	private hasDraft(): boolean {
		if ((this.comment ?? "").trim() !== "") return true;
		return this.request.questions.some((question) => this.isAnswered(question.id));
	}

	selectedFor(questionId: string): string[] {
		return this.selected.get(questionId) ?? [];
	}

	textFor(questionId: string): string | undefined {
		return this.texts.get(questionId);
	}

	isSelected(questionId: string, label: string): boolean {
		return this.selectedFor(questionId).includes(label);
	}

	isAnswered(questionId: string): boolean {
		if (this.selectedFor(questionId).length > 0) return true;
		return (this.texts.get(questionId) ?? "").trim() !== "";
	}

	answeredCount(): number {
		return this.request.questions.filter((question) => this.isAnswered(question.id)).length;
	}

	/** Select (single) or toggle (multi) an option of the active question. */
	activateOption(questionId: string, label: string): void {
		const question = this.request.questions.find((entry) => entry.id === questionId);
		if (!question?.options.some((option) => option.label === label)) return;
		if (question.multiSelect) {
			const next = [...this.selectedFor(questionId)];
			const index = next.indexOf(label);
			if (index >= 0) next.splice(index, 1);
			else next.push(label);
			this.selected.set(questionId, next);
		} else {
			this.selected.set(questionId, [label]);
		}
		this.notice = undefined;
	}

	/** Replace the question's answer with typed text; empty text clears it. */
	setOwnAnswer(questionId: string, text: string): void {
		const trimmed = text.trim();
		this.selected.delete(questionId);
		if (trimmed === "") this.texts.delete(questionId);
		else this.texts.set(questionId, trimmed);
		this.notice = undefined;
	}

	answers(): QuestionAnswers {
		const result: QuestionAnswers = {};
		for (const question of this.request.questions) {
			const selected = this.selectedFor(question.id);
			const text = this.texts.get(question.id);
			if (selected.length === 0 && text === undefined) continue;
			result[question.id] = { selected, ...(text !== undefined ? { text } : {}) };
		}
		return result;
	}

	unanswered(): string[] {
		return this.request.questions.filter((question) => !this.isAnswered(question.id)).map((q) => q.id);
	}

	/** Submit outcome: comment wins, then answers; undefined means stay open. */
	submitOutcome(forcePartial = false): "answered" | "comment-submitted" | undefined {
		if ((this.comment ?? "").trim() !== "") return "comment-submitted";
		if (this.unanswered().length === 0) return "answered";
		if (this.answeredCount() > 0) return "answered";
		if (forcePartial) return "answered";
		return undefined;
	}

	buildResponse(status: QuestionResponse["status"], autoResolvedAfterMs?: number): QuestionResponse {
		const comment = this.comment !== undefined && this.comment.trim() !== "" ? this.comment : undefined;
		return {
			status,
			answers: this.answers(),
			...(comment !== undefined ? { comment } : {}),
			unanswered: this.unanswered(),
			...(autoResolvedAfterMs !== undefined ? { autoResolvedAfterMs } : {}),
		};
	}

	refreshDraft(): QuestionDraft {
		const comment = this.comment !== undefined && this.comment.trim() !== "" ? this.comment : undefined;
		return {
			answers: this.answers(),
			...(comment !== undefined ? { comment } : {}),
		};
	}
}
