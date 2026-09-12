/**
 * Collapsed one-line widget for a pending async (waitForAnswer=false)
 * question: it sits above the editor, shows the unanswered count and the
 * idle countdown, and names the shortcut that expands the full
 * AskUserQuestionComponent. The response-building helpers here are pure so
 * interactive-mode can turn ordinary composer text into the comment answer.
 */

import {
	Container,
	decodeKittyPrintable,
	getKeybindings,
	type KeybindingsManager,
	type KeyId,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { QuestionRequest, QuestionResponse } from "../../../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import { formatCountdownLabel, type QuestionDraft } from "./ask-user-question-state.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { keyText } from "./keybinding-hints.ts";

/** Widget slot key used with `setWidget`; one pending async question at a time. */
export const ASK_USER_WIDGET_KEY = "ask-user";
/** Keybinding action (default `alt+a`, rebindable in keybindings.json) that expands the pending question. */
export const ASK_USER_ANSWER_KEYBINDING = "app.question.answer";
/**
 * What each letter key types on a US-layout macOS keyboard while Option is
 * held and the terminal lets Option compose characters instead of sending
 * Alt (the default in Terminal.app, iTerm2, Ghostty and kitty), as
 * `[Option+letter, Option+Shift+letter]`. Accepting the glyphs of the bound
 * `alt+<letter>` chords keeps the advertised shortcut working without a
 * terminal-settings detour; other platforms never see Option this way, so
 * they keep treating the glyphs as text. The dead keys `e`, `i`, `n` and `u`
 * compose with the next keystroke instead of typing a glyph, so a binding on
 * one of them needs the terminal's Option-as-Meta setting.
 */
const DARWIN_OPTION_GLYPHS: Readonly<Record<string, readonly [string, string]>> = {
	a: ["å", "Å"],
	b: ["∫", "ı"],
	c: ["ç", "Ç"],
	d: ["∂", "Î"],
	f: ["ƒ", "Ï"],
	g: ["©", "˝"],
	h: ["˙", "Ó"],
	j: ["∆", "Ô"],
	k: ["˚", "\uf8ff"],
	l: ["¬", "Ò"],
	m: ["µ", "Â"],
	o: ["ø", "Ø"],
	p: ["π", "∏"],
	q: ["œ", "Œ"],
	r: ["®", "‰"],
	s: ["ß", "Í"],
	t: ["†", "ˇ"],
	v: ["√", "◊"],
	w: ["∑", "„"],
	x: ["≈", "˛"],
	y: ["¥", "Á"],
	z: ["Ω", "¸"],
};

/** Glyphs the bound `alt+<letter>` chords type on darwin when Option composes. */
export function darwinOptionGlyphs(keys: readonly KeyId[]): ReadonlySet<string> {
	const glyphs = new Set<string>();
	for (const key of keys) {
		const letter = /^alt\+([a-z])$/i.exec(key)?.[1]?.toLowerCase();
		if (letter === undefined) continue;
		for (const glyph of DARWIN_OPTION_GLYPHS[letter] ?? []) glyphs.add(glyph);
	}
	return glyphs;
}

/** True when `data` is the editor input that expands the pending question on `platform`. */
export function matchesAskUserAnswerKey(
	data: string,
	platform: NodeJS.Platform = process.platform,
	keybindings: KeybindingsManager = getKeybindings(),
): boolean {
	if (keybindings.matches(data, ASK_USER_ANSWER_KEYBINDING)) return true;
	if (platform !== "darwin") return false;
	return darwinOptionGlyphs(keybindings.getKeys(ASK_USER_ANSWER_KEYBINDING)).has(decodeKittyPrintable(data) ?? data);
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

/** Hint naming every way into the pending question; the shortcut segment follows the effective binding. */
export function renderAnswerHint(): string {
	const shortcut = keyText(ASK_USER_ANSWER_KEYBINDING);
	if (shortcut === "") return theme.fg("muted", "type your reply to answer");
	return theme.fg("dim", shortcut) + theme.fg("muted", " to answer, or just type your reply");
}

export function renderAsyncQuestionLine(unanswered: number, countdownLabel: string): string {
	const countdown = countdownLabel === "" ? "" : theme.fg("muted", ` · ${countdownLabel}`);
	return (
		theme.fg("accent", theme.bold("?")) +
		theme.fg("text", ` Question pending (${unanswered} unanswered)`) +
		theme.fg("muted", " - ") +
		renderAnswerHint() +
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
