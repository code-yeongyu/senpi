/**
 * Collapsed one-line widget for a pending async (waitForAnswer=false)
 * question: it sits above the editor, shows the unanswered count and the
 * idle countdown, and names the shortcut that expands the full
 * AskUserQuestionComponent. The response-building helpers here are pure so
 * interactive-mode can turn ordinary composer text into the comment answer.
 */

import { Container, decodeKittyPrintable, matchesKey, Text, type TUI } from "@earendil-works/pi-tui";
import type { QuestionRequest, QuestionResponse } from "../../../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import { formatCountdownLabel, type QuestionDraft } from "./ask-user-question-state.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { rawKeyHint } from "./keybinding-hints.ts";

/** Widget slot key used with `setWidget`; one pending async question at a time. */
export const ASK_USER_WIDGET_KEY = "ask-user";
/** Editor shortcut that expands the pending question into the full component. */
export const ASK_USER_ANSWER_KEY = "alt+a";
/**
 * What the `a` key types on macOS when the terminal lets Option compose
 * characters instead of sending it as Alt (the default in Terminal.app,
 * iTerm2, Ghostty and kitty). Accepting these keeps the advertised `option+a`
 * working without a terminal-settings detour; other platforms never see
 * Option this way, so they keep treating the glyphs as text.
 */
const DARWIN_OPTION_A_GLYPHS: ReadonlySet<string> = new Set(["å", "Å"]);

/** True when `data` is the editor input that expands the pending question on `platform`. */
export function matchesAskUserAnswerKey(data: string, platform: NodeJS.Platform = process.platform): boolean {
	if (matchesKey(data, ASK_USER_ANSWER_KEY)) return true;
	if (platform !== "darwin") return false;
	return DARWIN_OPTION_A_GLYPHS.has(decodeKittyPrintable(data) ?? data);
}

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

export function renderAsyncQuestionLine(unanswered: number, countdownLabel: string): string {
	const countdown = countdownLabel === "" ? "" : theme.fg("muted", ` · ${countdownLabel}`);
	return (
		theme.fg("accent", theme.bold("?")) +
		theme.fg("text", ` Question pending (${unanswered} unanswered)`) +
		theme.fg("muted", " - ") +
		rawKeyHint(ASK_USER_ANSWER_KEY, "to answer, or just type your reply") +
		countdown
	);
}

export interface AskUserAsyncWidgetOptions {
	unanswered: number;
	/** Idle countdown shown in the line; 0 disables it. */
	timeoutMs: number;
	tui?: TUI;
	onExpire: () => void;
}

export class AskUserAsyncWidget extends Container {
	private readonly line = new Text("", 1, 0);
	private readonly countdown: CountdownTimer | undefined;
	private unanswered: number;
	private countdownLabel = "";

	constructor(options: AskUserAsyncWidgetOptions) {
		super();
		this.unanswered = options.unanswered;
		this.addChild(this.line);
		if (options.timeoutMs > 0) {
			this.countdown = new CountdownTimer(
				options.timeoutMs,
				options.tui,
				(seconds) => {
					this.countdownLabel = formatCountdownLabel(seconds * 1000);
					this.update();
				},
				options.onExpire,
			);
		}
		this.update();
	}

	setUnanswered(count: number): void {
		this.unanswered = count;
		this.update();
	}

	dispose(): void {
		this.countdown?.dispose();
	}

	private update(): void {
		this.line.setText(renderAsyncQuestionLine(this.unanswered, this.countdownLabel));
	}
}
