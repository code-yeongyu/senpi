import { beforeAll, describe, expect, it, vi } from "vitest";
import type { QuestionRequest, QuestionResponse } from "../../src/core/extensions/types.ts";
import {
	AskUserQuestionComponent,
	type AskUserQuestionOptions,
} from "../../src/modes/interactive/components/ask-user-question.ts";
import { formatCountdownLabel } from "../../src/modes/interactive/components/ask-user-question-state.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const CTRL_C = "\x03";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const SPACE = " ";
const CTRL_ENTER = "\x1b[13;5u";

function buildRequest(): QuestionRequest {
	return {
		requestId: "req-1",
		questions: [
			{
				id: "auth",
				header: "Auth",
				question: "Which auth method should the CLI use?",
				options: [
					{ label: "OAuth", description: "Token-based login that works with SSO" },
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
		waitForAnswer: true,
		timeoutMs: 30 * 60_000,
	};
}

type Harness = {
	component: AskUserQuestionComponent;
	done: (response: QuestionResponse) => void;
	progress: (draft: { answers?: QuestionResponse["answers"]; comment?: string }) => void;
	doneCalls: QuestionResponse[];
	progressCalls: Array<{ answers?: QuestionResponse["answers"]; comment?: string }>;
	render: () => string;
};

function mount(request: QuestionRequest = buildRequest(), opts: AskUserQuestionOptions = {}): Harness {
	const doneCalls: QuestionResponse[] = [];
	const progressCalls: Harness["progressCalls"] = [];
	const component = new AskUserQuestionComponent(request, (response) => doneCalls.push(response), {
		...opts,
		onProgress: (draft) => progressCalls.push(draft),
	});
	return {
		component,
		done: () => undefined,
		progress: () => undefined,
		doneCalls,
		progressCalls,
		render: () => stripAnsi(component.render(100).join("\n")),
	};
}

describe("AskUserQuestionComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders tabs, numbered options, own-answer row and submit tab", () => {
		const h = mount();
		const output = h.render();

		expect(output).toContain("Auth");
		expect(output).toContain("Extras");
		expect(output).toContain("Which auth method should the CLI use?");
		expect(output).toContain("1. OAuth");
		expect(output).toContain("Token-based login that works with SSO");
		expect(output).toContain("2. API key");
		expect(output).toContain("Type your own answer...");
		expect(output).toContain("Submit");
		expect(output).toContain("Submit (0/2 answered)");
	});

	it("selects an option by digit and advances to the next question", () => {
		const h = mount();

		h.component.handleInput("1");

		expect(h.doneCalls).toHaveLength(0);
		expect(h.render()).toContain("Which extras should be enabled?");
		expect(h.progressCalls.length).toBeGreaterThanOrEqual(1);
		const last = h.progressCalls[h.progressCalls.length - 1];
		expect(last?.answers?.auth).toEqual({ selected: ["OAuth"] });
	});

	it("advances to the next question when Enter confirms a single-select option", () => {
		const h = mount();

		h.component.handleInput(ENTER);

		expect(h.doneCalls).toHaveLength(0);
		expect(h.render()).toContain("Which extras should be enabled?");
	});

	it("submits immediately when Enter confirms the only question", () => {
		const request = buildRequest();
		const h = mount({ ...request, questions: [request.questions[0]!] });

		h.component.handleInput(ENTER);

		expect(h.doneCalls).toHaveLength(1);
		expect(h.doneCalls[0]?.status).toBe("answered");
	});

	it("keeps multi-select choices when Enter confirms them", () => {
		const h = mount();

		h.component.handleInput(TAB);
		h.component.handleInput(SPACE);
		h.component.handleInput(ENTER);
		h.component.handleInput(ENTER);
		h.component.handleInput(ENTER);

		expect(h.doneCalls).toHaveLength(1);
		expect(h.doneCalls[0]?.answers.extras).toEqual({ selected: ["Verbose logging"] });
		expect(h.doneCalls[0]?.unanswered).toEqual(["auth"]);
	});

	it("keeps the options view reachable after moving down at its last row", () => {
		const h = mount();

		h.component.handleInput(DOWN);
		h.component.handleInput(DOWN);
		h.component.handleInput(DOWN);
		h.component.handleInput(UP);
		h.component.handleInput(DOWN);

		h.component.handleInput(ENTER);
		expect(h.render()).toContain("Your answer (enter to save, esc to discard)");
	});

	it("requires confirmation before dismissing a question with draft answers", () => {
		const h = mount();

		h.component.handleInput("1");
		h.component.handleInput(ESC);

		expect(h.doneCalls).toHaveLength(0);
		expect(h.render()).toContain("Press Esc again to dismiss");
	});

	it("cancels immediately with Ctrl+C from every focus", () => {
		const h = mount();

		h.component.handleInput("c");
		h.component.handleInput(CTRL_C);

		expect(h.doneCalls).toHaveLength(1);
		expect(h.doneCalls[0]?.status).toBe("cancelled");
	});

	it("toggles multi-select options with space", () => {
		const h = mount();

		h.component.handleInput(TAB);
		h.component.handleInput(SPACE);
		h.component.handleInput(DOWN);
		h.component.handleInput(SPACE);

		expect(h.doneCalls).toHaveLength(0);
		const last = h.progressCalls[h.progressCalls.length - 1];
		expect(last?.answers?.extras?.selected).toEqual(["Verbose logging", "Dry run"]);

		h.component.handleInput(UP);
		h.component.handleInput(SPACE);
		const afterToggleOff = h.progressCalls[h.progressCalls.length - 1];
		expect(afterToggleOff?.answers?.extras?.selected).toEqual(["Dry run"]);
	});

	it("submits a comment with Enter in the comment editor keeping unanswered ids", () => {
		const h = mount();

		h.component.handleInput("1");
		h.component.handleInput("c");
		h.component.handleInput("just ship it");
		h.component.handleInput(ENTER);

		expect(h.doneCalls).toHaveLength(1);
		const response = h.doneCalls[0];
		expect(response?.status).toBe("comment-submitted");
		expect(response?.comment).toBe("just ship it");
		expect(response?.answers.auth).toEqual({ selected: ["OAuth"] });
		expect(response?.unanswered).toEqual(["extras"]);
	});

	it("cancels on Esc from the options view", () => {
		const h = mount();

		h.component.handleInput(ESC);

		expect(h.doneCalls).toHaveLength(1);
		expect(h.doneCalls[0]?.status).toBe("cancelled");
	});

	it("submits a single-select question with Enter", () => {
		const request = buildRequest();
		const single = mount({ ...request, questions: [request.questions[0]!] });

		single.component.handleInput(ENTER);

		expect(single.doneCalls).toHaveLength(1);
		expect(single.doneCalls[0]?.status).toBe("answered");
	});

	it("keeps an async one-question selection open for an optional comment", () => {
		const request = buildRequest();
		const asyncQuestion = mount({
			...request,
			waitForAnswer: false,
			questions: [request.questions[0]!],
		});

		asyncQuestion.component.handleInput("1");

		expect(asyncQuestion.doneCalls).toHaveLength(0);
		expect(asyncQuestion.render()).toContain("Review your answers");
	});

	it("preserves the first printable character when opening own-answer", () => {
		const request = buildRequest();
		const h = mount({ ...request, questions: [request.questions[0]!] });

		h.component.handleInput("x");
		h.component.handleInput("rest");
		h.component.handleInput(ENTER);
		h.component.handleInput(ENTER);

		expect(h.doneCalls[0]?.answers.auth).toEqual({ selected: [], text: "xrest" });
	});

	it("submits answered status from the Submit tab once every question is answered", () => {
		const h = mount();

		h.component.handleInput("1");
		h.component.handleInput(SPACE);
		h.component.handleInput(ENTER);
		h.component.handleInput(ENTER);

		expect(h.doneCalls).toHaveLength(1);
		const response = h.doneCalls[0];
		expect(response?.status).toBe("answered");
		expect(response?.unanswered).toEqual([]);
		expect(response?.answers.extras).toEqual({ selected: ["Verbose logging"] });
	});

	it("submits partial answers without requiring a comment", () => {
		const h = mount();

		h.component.handleInput("1");
		h.component.handleInput("c");
		h.component.handleInput(ENTER);

		expect(h.doneCalls).toHaveLength(1);
		expect(h.doneCalls[0]?.status).toBe("answered");
		expect(h.doneCalls[0]?.unanswered).toEqual(["extras"]);
	});

	it("shows the not-answered notice and stays open on an empty partial submit", () => {
		const h = mount();

		h.component.handleInput(CTRL_ENTER);

		expect(h.doneCalls).toHaveLength(0);
		expect(h.render()).toContain("You have not answered all questions");
	});

	it("commits a typed own answer for the active question", () => {
		const h = mount();

		// Move to the own-answer row (two options above it) and open the editor.
		h.component.handleInput(DOWN);
		h.component.handleInput(DOWN);
		h.component.handleInput(ENTER);
		h.component.handleInput("use a vault token");
		h.component.handleInput(ENTER);

		const last = h.progressCalls[h.progressCalls.length - 1];
		expect(last?.answers?.auth).toEqual({ selected: [], text: "use a vault token" });
		expect(h.render()).toContain("Which extras should be enabled?");
	});

	it("clears the own-answer editor when advancing to the next question", () => {
		const h = mount();

		// Q1: open the own-answer editor and commit a typed answer.
		h.component.handleInput(DOWN);
		h.component.handleInput(DOWN);
		h.component.handleInput(ENTER);
		h.component.handleInput("use a vault token");
		h.component.handleInput(ENTER);

		// Q2: the editor must start empty instead of carrying Q1's text over.
		expect(h.render()).toContain("Which extras should be enabled?");
		expect(h.render()).not.toContain("use a vault token");

		// Committing again on Q2 must not submit Q1's text as Q2's own answer.
		h.component.handleInput(ENTER);

		const last = h.progressCalls[h.progressCalls.length - 1];
		expect(last?.answers?.extras).toBeUndefined();
		expect(h.doneCalls).toHaveLength(0);
	});

	it("reloads a saved own answer when the question is revisited", () => {
		const h = mount();

		h.component.handleInput(DOWN);
		h.component.handleInput(DOWN);
		h.component.handleInput(ENTER);
		h.component.handleInput("use a vault token");
		h.component.handleInput(ENTER);

		// Back to Q1 via the tab bar and reopen its own-answer editor.
		h.component.handleInput(SHIFT_TAB);
		h.component.handleInput(DOWN);
		h.component.handleInput(DOWN);
		h.component.handleInput(ENTER);

		expect(h.render()).toContain("use a vault token");
	});

	it("formats the countdown as minutes above five minutes and mm:ss below", () => {
		expect(formatCountdownLabel(30 * 60_000)).toBe("30m");
		expect(formatCountdownLabel(5 * 60_000)).toBe("5m");
		expect(formatCountdownLabel(4 * 60_000 + 59_000)).toBe("04:59");
		expect(formatCountdownLabel(59_000)).toBe("00:59");
	});

	it("ticks the countdown chip to mm:ss under five minutes", () => {
		vi.useFakeTimers();
		try {
			const h = mount(buildRequest(), { timeoutMs: 5 * 60_000 });

			expect(h.render()).toContain("5m");
			vi.advanceTimersByTime(1_000);

			expect(h.render()).toContain("04:59");
		} finally {
			vi.useRealTimers();
		}
	});

	it("resolves timed_out when the countdown expires", () => {
		vi.useFakeTimers();
		try {
			const h = mount(buildRequest(), { timeoutMs: 60_000 });

			h.component.handleInput("1");
			vi.advanceTimersByTime(60_000);

			expect(h.doneCalls).toHaveLength(1);
			const response = h.doneCalls[0];
			expect(response?.status).toBe("timed_out");
			expect(response?.answers.auth).toEqual({ selected: ["OAuth"] });
			expect(response?.unanswered).toEqual(["extras"]);
		} finally {
			vi.useRealTimers();
		}
	});
});
