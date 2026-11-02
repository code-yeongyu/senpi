import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { QuestionRequest } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { ASK_USER_WIDGET_KEY } from "../../src/modes/interactive/components/ask-user-async-widget.ts";
import { AskUserQuestionComponent } from "../../src/modes/interactive/components/ask-user-question.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createFakeInteractiveMode, type FakeInteractiveMode } from "./helpers/ask-user-async-fake-mode.ts";

const ESC = "\x1b";

function buildRequest(): QuestionRequest {
	return {
		requestId: "req-key-free",
		questions: [
			{
				id: "auth",
				header: "Auth",
				question: "Which auth method?",
				options: [{ label: "OAuth" }, { label: "API key" }],
				multiSelect: false,
			},
		],
		waitForAnswer: false,
		timeoutMs: 30 * 60_000,
	};
}

function askPending(fake: FakeInteractiveMode): Promise<unknown> {
	const pending = fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
	if (!pending) throw new Error("question() returned nothing");
	return pending;
}

function overlay(fake: FakeInteractiveMode): AskUserQuestionComponent | undefined {
	return fake.editorContainer.children.find((child) => child instanceof AskUserQuestionComponent);
}

describe("key-free ways into a pending async question", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("opens the pending question on Enter with an empty editor", async () => {
		const fake = createFakeInteractiveMode({ isStreaming: true });
		void askPending(fake);

		await fake.submitEditorText("");

		const component = overlay(fake);
		expect(component).toBeInstanceOf(AskUserQuestionComponent);
		expect(fake.ui.setFocus).toHaveBeenLastCalledWith(component);
		expect(fake.session.prompt).not.toHaveBeenCalled();
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
	});

	it("collapses back to the widget on Esc after an empty-Enter expansion", async () => {
		const fake = createFakeInteractiveMode({ isStreaming: true });
		void askPending(fake);
		await fake.submitEditorText("");

		overlay(fake)?.handleInput(ESC);

		expect(overlay(fake)).toBeUndefined();
		expect(fake.editorContainer.children).toContain(fake.editor);
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("Question pending (1 unanswered)");
	});

	it("keeps an empty Enter a no-op when nothing is pending", async () => {
		const fake = createFakeInteractiveMode({ isStreaming: false });

		await fake.submitEditorText("");

		expect(overlay(fake)).toBeUndefined();
		expect(fake.session.prompt).not.toHaveBeenCalled();
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
		expect(fake.showStatus).not.toHaveBeenCalled();
	});

	it("opens the pending question on /answer", async () => {
		const fake = createFakeInteractiveMode({ isStreaming: true });
		void askPending(fake);

		await fake.submitEditorText("/answer");

		expect(overlay(fake)).toBeInstanceOf(AskUserQuestionComponent);
		expect(fake.editor.setText).toHaveBeenCalledWith("");
		expect(fake.session.prompt).not.toHaveBeenCalled();
		expect(fake.showStatus).not.toHaveBeenCalled();
	});

	it("reports that nothing is pending on /answer without a question", async () => {
		const fake = createFakeInteractiveMode({ isStreaming: false });

		await fake.submitEditorText("/answer");

		expect(overlay(fake)).toBeUndefined();
		expect(fake.showStatus).toHaveBeenCalledWith("No question is pending.");
		expect(fake.editor.setText).toHaveBeenCalledWith("");
		expect(fake.session.prompt).not.toHaveBeenCalled();
	});

	it("names Enter and /answer in the widget hint beside the shortcut", () => {
		const fake = createFakeInteractiveMode();
		void askPending(fake);

		const text = stripAnsi(fake.widgetText(ASK_USER_WIDGET_KEY) ?? "");
		expect(text).toContain("enter");
		expect(text).toContain("/answer");
		expect(text).toContain("to answer");
	});
});
