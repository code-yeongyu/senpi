/**
 * Collapsed widget for a pending async (waitForAnswer=false) question: it
 * sits above the editor and shows the unanswered count with the idle
 * countdown, the first unanswered question with its options, and every way
 * into the full AskUserQuestionComponent. The response-building helpers here
 * are pure so interactive-mode can turn ordinary composer text into the
 * comment answer.
 */

import { Container, Text, TruncatedText, type TUI } from "@earendil-works/pi-tui";
import type { QuestionRequest, QuestionResponse } from "../../../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import { askUserAnswerKeyHint } from "./ask-user-answer-key.ts";
import { AskUserCountdown } from "./ask-user-countdown.ts";
import { formatCountdownLabel, type QuestionDraft } from "./ask-user-question-state.ts";
import { keyText } from "./keybinding-hints.ts";

/** Host-owned widget slot displaying one request from the pending queue. */
export const ASK_USER_WIDGET_KEY = "ask-user";

type Question = QuestionRequest["questions"][number];

const INDENT = "  ";

function hasAnswer(answer: QuestionResponse["answers"][string] | undefined): boolean {
	if (!answer) return false;
	if (answer.selected.length > 0) return true;
	return (answer.text ?? "").trim() !== "";
}

/** Question ids the draft has not answered yet. */
export function unansweredIds(request: QuestionRequest, draft: QuestionDraft): string[] {
	return request.questions.filter((question) => !hasAnswer(draft.answers?.[question.id])).map((q) => q.id);
}

/** Response for composer text typed while the question is pending: the text is the comment. */
export function buildCommentResponse(
	request: QuestionRequest,
	draft: QuestionDraft,
	comment: string,
): QuestionResponse {
	return {
		status: "comment-submitted",
		answers: draft.answers ?? {},
		comment,
		unanswered: unansweredIds(request, draft),
	};
}

/** Response for an idle countdown that expired while the widget was collapsed. */
export function buildTimedOutResponse(
	request: QuestionRequest,
	draft: QuestionDraft,
	autoResolvedAfterMs: number,
): QuestionResponse {
	const comment = draft.comment?.trim();
	return {
		status: "timed_out",
		answers: draft.answers ?? {},
		...(comment ? { comment } : {}),
		unanswered: unansweredIds(request, draft),
		autoResolvedAfterMs,
	};
}

export function renderStatusLine(unanswered: number, countdownLabel: string, pendingCount = 1): string {
	const countdown = countdownLabel === "" ? "" : theme.fg("muted", ` · ${countdownLabel}`);
	return (
		theme.fg("accent", theme.bold("?")) +
		theme.fg(
			"text",
			pendingCount > 1 ? ` ${pendingCount} questions pending` : ` Question pending (${unanswered} unanswered)`,
		) +
		countdown
	);
}

export function renderQuestionLine(question: Question): string {
	return (
		INDENT +
		theme.fg("text", theme.bold(question.header)) +
		theme.fg("muted", " — ") +
		theme.fg("text", question.question)
	);
}

export function renderOptionsLine(question: Question, remaining: number): string {
	const parts = question.options.map(
		(option, index) => theme.fg("dim", `${index + 1}`) + theme.fg("muted", ` ${option.label}`),
	);
	parts.push(theme.fg("muted", "own answer"));
	if (remaining > 0) parts.push(theme.fg("muted", `+${remaining} more question${remaining === 1 ? "" : "s"}`));
	return INDENT + parts.join(theme.fg("muted", " · "));
}

/** Hint naming every way into the pending question; the shortcut segment follows the effective binding. */
export function renderAnswerHint(): string {
	const shortcut = askUserAnswerKeyHint();
	const keys = shortcut === "" ? "enter" : `enter or ${shortcut}`;
	return [
		theme.fg("dim", keys) + theme.fg("muted", " to answer"),
		theme.fg("dim", "/answer"),
		theme.fg("muted", "or just type your reply"),
	].join(theme.fg("muted", " · "));
}

export interface AskUserAsyncWidgetOptions {
	request: QuestionRequest;
	draft: QuestionDraft;
	/** Idle countdown shown in the line; 0 disables it. */
	timeoutMs: number;
	getDeadlineAtMs?: () => number;
	pendingCount?: number;
	tui?: TUI;
	onExpire: () => void;
}

export class AskUserAsyncWidget extends Container {
	private readonly request: QuestionRequest;
	private readonly draft: QuestionDraft;
	private readonly countdown: AskUserCountdown | undefined;
	private readonly pendingCount: number;
	private countdownLabel = "";

	constructor(options: AskUserAsyncWidgetOptions) {
		super();
		this.request = options.request;
		this.draft = options.draft;
		this.pendingCount = options.pendingCount ?? 1;
		if (options.timeoutMs > 0 || options.getDeadlineAtMs) {
			this.countdown = new AskUserCountdown(
				options.timeoutMs,
				options.tui,
				(remainingMs) => {
					this.countdownLabel = formatCountdownLabel(remainingMs);
					this.update();
				},
				options.onExpire,
				options.getDeadlineAtMs,
			);
		}
		this.update();
	}

	dispose(): void {
		this.countdown?.dispose();
		super.dispose();
	}

	private update(): void {
		const pending = unansweredIds(this.request, this.draft);
		const shown = this.request.questions.find((question) => question.id === pending[0]);
		this.clear();
		this.addChild(new Text(renderStatusLine(pending.length, this.countdownLabel, this.pendingCount), 1, 0));
		if (shown) {
			this.addChild(new TruncatedText(renderQuestionLine(shown), 1, 0));
			this.addChild(new TruncatedText(renderOptionsLine(shown, pending.length - 1), 1, 0));
		}
		const nextHint =
			this.pendingCount > 1
				? theme.fg("muted", ` · +${this.pendingCount - 1} more · ${keyText("app.question.next")} next question`)
				: "";
		this.addChild(new Text(INDENT + renderAnswerHint() + nextHint, 1, 0));
	}
}
