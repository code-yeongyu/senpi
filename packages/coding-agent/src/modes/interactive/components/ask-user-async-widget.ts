/**
 * Collapsed widget for a pending async (waitForAnswer=false) question: it
 * sits above the editor and shows the unanswered count with the idle
 * countdown, the first unanswered question with its options, and every way
 * into the full AskUserQuestionComponent. The response-building helpers here
 * are pure so interactive-mode can turn ordinary composer text into the
 * comment answer.
 */

import {
	type Component,
	sanitizeTerminalLabel,
	Text,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
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
	mouseCaptureActive?: boolean;
	onOptionClick?: (optionIndex: number) => void;
	onOwnAnswerClick?: () => void;
	onExpandClick?: () => void;
	onNextQuestion?: () => void;
}

interface WidgetHit {
	action: number | "own-answer" | "expand" | "next";
	row: number;
	startColumn: number;
	endColumn: number;
}

export class AskUserAsyncWidget implements Component {
	private readonly request: QuestionRequest;
	private readonly draft: QuestionDraft;
	private readonly countdown: AskUserCountdown | undefined;
	private readonly pendingCount: number;
	private countdownLabel = "";
	private hits: WidgetHit[] = [];
	private renderedWidth = 0;
	private readonly options: AskUserAsyncWidgetOptions;

	constructor(options: AskUserAsyncWidgetOptions) {
		this.options = options;
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
	}

	invalidate(): void {}

	private update(): void {
		this.options.tui?.requestRender();
	}

	render(width: number): string[] {
		this.hits = [];
		this.renderedWidth = width;
		if (width < 5) return [truncateToWidth("Use keys to answer", width)];
		const pending = unansweredIds(this.request, this.draft);
		const shown = this.request.questions.find((question) => question.id === pending[0]);
		const lines: string[] = [];
		const addAction = (text: string, action: WidgetHit["action"]): void => {
			const line = truncateToWidth(text, width);
			this.hits.push({ action, row: lines.length, startColumn: 0, endColumn: visibleWidth(line) });
			lines.push(line);
		};
		addAction(renderStatusLine(pending.length, this.countdownLabel, this.pendingCount), "expand");
		if (shown) {
			addAction(
				renderQuestionLine({
					...shown,
					header: sanitizeTerminalLabel(shown.header),
					question: sanitizeTerminalLabel(shown.question),
				}),
				"expand",
			);
			let line = "";
			const labels = [...shown.options.map((option) => sanitizeTerminalLabel(option.label)), "own answer…"];
			for (const [index, label] of labels.entries()) {
				const button = `[ ${truncateToWidth(label, width - 4, "…")} ]`;
				if (line !== "" && visibleWidth(line) + 2 + visibleWidth(button) > width) {
					lines.push(line);
					line = "";
				}
				if (line !== "") line += "  ";
				const startColumn = visibleWidth(line);
				line += theme.fg("muted", button);
				this.hits.push({
					action: index === shown.options.length ? "own-answer" : index,
					row: lines.length,
					startColumn,
					endColumn: visibleWidth(line),
				});
			}
			if (line !== "") lines.push(line);
			if (pending.length > 1)
				lines.push(
					truncateToWidth(
						theme.fg("muted", `+${pending.length - 1} more question${pending.length === 2 ? "" : "s"}`),
						width,
					),
				);
		}
		if (this.pendingCount > 1)
			addAction(
				theme.fg("muted", `▸ +${this.pendingCount - 1} more · ${keyText("app.question.next")} next question`),
				"next",
			);
		if (this.options.mouseCaptureActive) {
			const bypass = ["iTerm.app", "Apple_Terminal"].includes(process.env.TERM_PROGRAM ?? "")
				? "option+drag"
				: "shift+drag";
			lines.push(...new Text(theme.fg("muted", `click an option · ${bypass} to select text`), 0, 0).render(width));
		}
		lines.push(...new Text(renderAnswerHint(), 0, 0).render(width));
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (
			event.width !== this.renderedWidth ||
			event.button !== "left" ||
			event.shift ||
			event.alt ||
			event.ctrl ||
			(event.type !== "press" && (event.type !== "click" || event.clickCount !== 1))
		)
			return undefined;
		const hit = this.hits.find(
			(span) => span.row === event.y && event.x >= span.startColumn && event.x < span.endColumn,
		);
		if (!hit) return undefined;
		if (event.type === "click") {
			if (typeof hit.action === "number") this.options.onOptionClick?.(hit.action);
			else if (hit.action === "own-answer") this.options.onOwnAnswerClick?.();
			else if (hit.action === "expand") this.options.onExpandClick?.();
			else this.options.onNextQuestion?.();
		}
		return { handled: true };
	}
}
