import { expect } from "vitest";
import type { QuestionRequest, QuestionResponse } from "../../src/core/extensions/types.ts";
import {
	AskUserQuestionComponent,
	type AskUserQuestionOptions,
} from "../../src/modes/interactive/components/ask-user-question.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

export const KEY = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	esc: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
	backspace: "\x7f",
	space: " ",
} as const;

export const OWN_ANSWER_EDITOR = "Your answer (";

export function buildFocusRequest(waitForAnswer = true): QuestionRequest {
	return {
		requestId: "req-focus",
		questions: [
			{
				id: "auth",
				header: "Auth",
				question: "Which auth method should the CLI use?",
				options: [
					{ label: "OAuth", description: "Token-based login" },
					{ label: "API key", description: "Paste a static key" },
				],
				multiSelect: false,
			},
			{
				id: "extras",
				header: "Extras",
				question: "Which extras should be enabled?",
				options: [
					{ label: "Verbose logging", description: "Log every request" },
					{ label: "Dry run", description: "Do not touch the disk" },
				],
				multiSelect: true,
			},
		],
		waitForAnswer,
		timeoutMs: 0,
	};
}

export type Draft = { answers?: QuestionResponse["answers"]; comment?: string };

export type FocusHarness = {
	component: AskUserQuestionComponent;
	keys: (...sequence: string[]) => void;
	doneCalls: QuestionResponse[];
	progressCalls: Draft[];
	lastDraft: () => Draft | undefined;
	render: () => string;
};

export function mountFocus(
	request: QuestionRequest = buildFocusRequest(),
	opts: AskUserQuestionOptions = {},
): FocusHarness {
	const doneCalls: QuestionResponse[] = [];
	const progressCalls: Draft[] = [];
	const component = new AskUserQuestionComponent(request, (response) => doneCalls.push(response), {
		...opts,
		onProgress: (draft) => progressCalls.push(draft),
	});
	return {
		component,
		keys: (...sequence) => {
			for (const key of sequence) component.handleInput(key);
		},
		doneCalls,
		progressCalls,
		lastDraft: () => progressCalls[progressCalls.length - 1],
		render: () => stripAnsi(component.render(100).join("\n")),
	};
}

/** Open the own-answer editor of the active question (two options above the row). */
export function openOwnAnswer(h: FocusHarness): void {
	h.keys(KEY.down, KEY.down, KEY.enter);
	expect(h.render()).toContain(OWN_ANSWER_EDITOR);
}

/** Answer both questions and land on the Submit tab with the comment editor focused. */
export function reachSubmit(h: FocusHarness): void {
	h.keys("1", KEY.space, KEY.tab);
	expect(h.render()).toContain("Review your answers");
}
