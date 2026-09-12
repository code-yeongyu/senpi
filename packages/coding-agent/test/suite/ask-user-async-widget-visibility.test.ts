import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { QuestionRequest } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { ASK_USER_WIDGET_KEY } from "../../src/modes/interactive/components/ask-user-async-widget.ts";
import { AskUserQuestionComponent } from "../../src/modes/interactive/components/ask-user-question.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createFakeInteractiveMode, type FakeInteractiveMode } from "./helpers/ask-user-async-fake-mode.ts";

const ESC = "\x1b";
const ALT_A = "\x1ba";
const WIDGET_WIDTH = 120;

const QUESTIONS: QuestionRequest["questions"] = [
	{
		id: "auth",
		header: "Auth",
		question: "Which auth method?",
		options: [
			{ label: "OAuth", description: "Token login" },
			{ label: "API key", description: "Static key" },
		],
		multiSelect: false,
	},
	{
		id: "deploy",
		header: "Deploy",
		question: "Where should it deploy?",
		options: [{ label: "Staging" }, { label: "Production" }],
		multiSelect: false,
	},
	{
		id: "extras",
		header: "Extras",
		question: "Anything else?",
		options: [{ label: "Docs" }, { label: "Tests" }],
		multiSelect: true,
	},
];

function buildRequest(questions: QuestionRequest["questions"]): QuestionRequest {
	return { requestId: "req-visible", questions, waitForAnswer: false, timeoutMs: 30 * 60_000 };
}

function askPending(fake: FakeInteractiveMode, questions: QuestionRequest["questions"]): void {
	const pending = fake.createExtensionUIContext().question?.(buildRequest(questions), { timeout: 30 * 60_000 });
	if (!pending) throw new Error("question() returned nothing");
}

function overlay(fake: FakeInteractiveMode): AskUserQuestionComponent {
	const component = fake.editorContainer.children.find((child) => child instanceof AskUserQuestionComponent);
	if (!(component instanceof AskUserQuestionComponent)) throw new Error("the question overlay is not mounted");
	return component;
}

function widgetLines(fake: FakeInteractiveMode): string[] {
	const text = fake.widgetText(ASK_USER_WIDGET_KEY);
	if (text === undefined) throw new Error("the async widget is not mounted");
	return text.split("\n");
}

describe("collapsed async ask-user widget content", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("shows the pending question and its options, not only the count", () => {
		const fake = createFakeInteractiveMode();
		askPending(fake, QUESTIONS.slice(0, 1));

		const text = widgetLines(fake).join("\n");
		expect(text).toContain("Question pending (1 unanswered)");
		expect(text).toContain("Auth — Which auth method?");
		expect(text).toContain("1 OAuth · 2 API key · own answer");
	});

	it("counts the questions that wait behind the shown one", () => {
		const two = createFakeInteractiveMode();
		askPending(two, QUESTIONS.slice(0, 2));
		expect(widgetLines(two).join("\n")).toContain("own answer · +1 more question");

		const three = createFakeInteractiveMode();
		askPending(three, QUESTIONS);
		expect(widgetLines(three).join("\n")).toContain("own answer · +2 more questions");
	});

	it("moves on to the next unanswered question when a partial draft collapses", () => {
		const fake = createFakeInteractiveMode({ isStreaming: true });
		askPending(fake, QUESTIONS.slice(0, 2));

		expect(fake.pressEditorKey(ALT_A)).toBe(true);
		overlay(fake).handleInput("1");
		overlay(fake).handleInput(ESC);

		const text = widgetLines(fake).join("\n");
		expect(text).toContain("Question pending (1 unanswered)");
		expect(text).toContain("Deploy — Where should it deploy?");
		expect(text).toContain("1 Staging · 2 Production · own answer");
		expect(text).not.toContain("Auth —");
		expect(text).not.toContain("more question");
	});

	it("drops the question lines once every question carries a draft answer", () => {
		const fake = createFakeInteractiveMode({ isStreaming: true });
		askPending(fake, QUESTIONS.slice(0, 1));

		fake.pressEditorKey(ALT_A);
		overlay(fake).handleInput("2");
		overlay(fake).handleInput(ESC);

		const text = widgetLines(fake).join("\n");
		expect(text).toContain("Question pending (0 unanswered)");
		expect(text).not.toContain("Auth —");
		expect(text).toContain("to answer");
	});

	it("keeps a long question and a long option list to one truncated line each", () => {
		const question =
			"Which of the many equally plausible database engines should this service standardize on? ".repeat(3);
		const options = Array.from({ length: 30 }, (_, index) => ({ label: `Engine number ${index + 1}` }));
		const fake = createFakeInteractiveMode();
		askPending(fake, [{ id: "db", header: "Database", question, options, multiSelect: false }]);

		const lines = widgetLines(fake);
		expect(lines).toHaveLength(4);
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(WIDGET_WIDTH);
		expect(lines[1]).toContain("Database — Which of the many equally plausible");
		expect(lines[1]?.match(/standardize on\?/g)).toHaveLength(1);
		expect(lines[2]).toContain("1 Engine number 1 · 2 Engine number 2");
		expect(lines[2]).not.toContain("Engine number 30");
	});
});
