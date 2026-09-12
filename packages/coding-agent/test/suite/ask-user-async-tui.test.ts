import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { QuestionRequest } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { ASK_USER_WIDGET_KEY } from "../../src/modes/interactive/components/ask-user-async-widget.ts";
import { AskUserQuestionComponent } from "../../src/modes/interactive/components/ask-user-question.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import type { Harness } from "./harness.ts";
import { createFakeInteractiveMode, type FakeInteractiveMode } from "./helpers/ask-user-async-fake-mode.ts";
import { ASYNC_QUESTIONS, createAskUserDelivery } from "./helpers/ask-user-delivery.ts";

const ESC = "\x1b";
const CTRL_ENTER = "\x1b[13;5u";
const ALT_A = "\x1ba";

function buildRequest(): QuestionRequest {
	return {
		requestId: "req-1",
		questions: [
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
		],
		waitForAnswer: false,
		timeoutMs: 30 * 60_000,
	};
}

function overlay(fake: FakeInteractiveMode): AskUserQuestionComponent | undefined {
	return fake.editorContainer.children.find((child) => child instanceof AskUserQuestionComponent);
}

function tuiQuestion(fake: FakeInteractiveMode) {
	const question = fake.createExtensionUIContext().question;
	if (!question) throw new Error("the TUI ui context has no question bridge");
	return question;
}

const harnesses: Harness[] = [];
afterEach(() => {
	for (const h of harnesses.splice(0)) h.cleanup();
	vi.useRealTimers();
});

describe("async ask-user question in the interactive TUI", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("shows the collapsed widget above the editor and no overlay", async () => {
		const fake = createFakeInteractiveMode();
		const pending = fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
		expect(pending).toBeInstanceOf(Promise);

		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("Question pending (1 unanswered)");
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("just type your reply");
		expect(overlay(fake)).toBeUndefined();
		expect(fake.editorContainer.children).toContain(fake.editor);
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
	});

	it("opens the component on the shortcut and resolves the question without delivering itself", async () => {
		const fake = createFakeInteractiveMode({ isStreaming: true });
		const pending = fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
		if (!pending) throw new Error("question() returned nothing");

		expect(fake.pressEditorKey(ALT_A)).toBe(true);
		const component = overlay(fake);
		if (!component) throw new Error("shortcut did not mount the question component");
		expect(fake.ui.setFocus).toHaveBeenLastCalledWith(component);

		component.handleInput("1");
		component.handleInput(CTRL_ENTER);
		const response = await pending;

		expect(response).toMatchObject({ status: "answered", answers: { auth: { selected: ["OAuth"] } } });
		// Delivery belongs to the extension; the widget only resolves the question.
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toBeUndefined();
		expect(overlay(fake)).toBeUndefined();
		expect(fake.editorContainer.children).toContain(fake.editor);
	});

	it("turns ordinary editor text into the comment answer exactly once", async () => {
		const fake = createFakeInteractiveMode({ isStreaming: true });
		const pending = fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
		if (!pending) throw new Error("question() returned nothing");

		await fake.submitEditorText("just use bun");
		const response = await pending;

		expect(response).toMatchObject({ status: "comment-submitted", comment: "just use bun", unanswered: ["auth"] });
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
		expect(fake.session.prompt).not.toHaveBeenCalled();
		expect(fake.onInputCallback).not.toHaveBeenCalled();
		expect(fake.editor.setText).toHaveBeenCalledWith("");
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toBeUndefined();

		await fake.submitEditorText("second message");
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
		expect(fake.session.prompt).toHaveBeenCalledWith(
			"second message",
			expect.objectContaining({ streamingBehavior: "steer" }),
		);
	});

	it("keeps slash and bash commands out of the comment path", async () => {
		const fake = createFakeInteractiveMode({ isStreaming: false });
		const pending = fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
		if (!pending) throw new Error("question() returned nothing");
		await fake.submitEditorText("/debug");
		expect(fake.handleDebugCommand).toHaveBeenCalledTimes(1);
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("Question pending");
	});

	it("returns to the widget on Esc without sending anything", async () => {
		const fake = createFakeInteractiveMode({ isStreaming: true });
		const pending = fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
		if (!pending) throw new Error("question() returned nothing");

		fake.pressEditorKey(ALT_A);
		overlay(fake)?.handleInput(ESC);

		expect(overlay(fake)).toBeUndefined();
		expect(fake.editorContainer.children).toContain(fake.editor);
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("Question pending (1 unanswered)");
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();

		await fake.submitEditorText("ok go");
		expect(await pending).toMatchObject({ status: "comment-submitted", comment: "ok go" });
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
	});

	it("drops the widget on abort without delivering", async () => {
		const fake = createFakeInteractiveMode();
		const controller = new AbortController();
		const pending = fake
			.createExtensionUIContext()
			.question?.(buildRequest(), { timeout: 30 * 60_000, signal: controller.signal });
		if (!pending) throw new Error("question() returned nothing");
		controller.abort();
		expect(await pending).toMatchObject({ status: "cancelled", unanswered: ["auth"] });
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toBeUndefined();
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
	});

	it("moves the wake source 1 -> 0 and delivers exactly one framed message per answer", async () => {
		const delivery = await createAskUserDelivery();
		harnesses.push(delivery.harness);
		const fake = createFakeInteractiveMode({ isStreaming: true });
		const ctx = delivery.context(tuiQuestion(fake), false);

		const result = await delivery.tool.execute(
			"tc-async",
			{ questions: ASYNC_QUESTIONS, waitForAnswer: false },
			undefined,
			undefined,
			ctx,
		);
		expect(result.details).toMatchObject({ accepted: true, status: "pending" });
		expect(delivery.wakeEvents).toEqual([
			{ source: "ask-user", activeCount: 1, items: [{ id: "tc-async", description: "Library" }] },
		]);
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("Question pending (1 unanswered)");

		const settled = delivery.settled(ctx, "tc-async");
		await fake.submitEditorText("just use bun");
		await settled;
		expect(delivery.wakeEvents).toEqual([
			{ source: "ask-user", activeCount: 1, items: [{ id: "tc-async", description: "Library" }] },
			{ source: "ask-user", activeCount: 0, items: [] },
		]);
		// Exactly one framed message, delivered by the extension and not by the widget.
		expect(delivery.deliveries).toEqual([
			{
				content: "[Answer to question tc-async]\nThe user responded: just use bun\nUnanswered: Library",
				options: { deliverAs: "steer" },
			},
		]);
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
	});

	it("delivers exactly one timeout message when the pending question expires unanswered", async () => {
		const delivery = await createAskUserDelivery(1);
		harnesses.push(delivery.harness);
		const fake = createFakeInteractiveMode({ isStreaming: false });
		const ctx = delivery.context(tuiQuestion(fake));
		vi.useFakeTimers();

		await delivery.tool.execute(
			"tc-timeout",
			{ questions: ASYNC_QUESTIONS, waitForAnswer: false },
			undefined,
			undefined,
			ctx,
		);
		const settled = delivery.settled(ctx, "tc-timeout");
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(settled).resolves.toMatchObject({ status: "timed_out" });

		expect(delivery.deliveries).toHaveLength(1);
		expect(String(delivery.deliveries[0]?.content)).toContain("(사용자가 답변을 안하고 timeout 으로 종료됨)");
		expect(delivery.deliveries[0]?.options).toEqual({ deliverAs: "followUp" });
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toBeUndefined();
	});

	it("drives the widget from a host question record and answers on the host channel", async () => {
		vi.useFakeTimers();
		const fake = createFakeInteractiveMode({ isStreaming: true });
		const sendHostUiProgress = vi.fn();
		fake.runtimeHost = { ...fake.runtimeHost, sendHostUiProgress };
		const handler = Reflect.get(InteractiveMode.prototype, "handleHostUiRequest");
		if (typeof handler !== "function") throw new Error("handleHostUiRequest missing");
		const pending: Promise<unknown> = handler.call(fake, {
			id: "ui-9",
			method: "question",
			requestId: "req-9",
			toolCallId: "tc-9",
			waitForAnswer: false,
			questions: buildRequest().questions,
			timeout: 30 * 60_000,
			askedAtMs: 0,
			deadlineAtMs: 30 * 60_000,
			remainingMs: 30 * 60_000,
		});

		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("Question pending (1 unanswered)");
		expect(overlay(fake)).toBeUndefined();

		fake.pressEditorKey(ALT_A);
		overlay(fake)?.handleInput("2");
		vi.advanceTimersByTime(1_000);
		expect(sendHostUiProgress).toHaveBeenCalledWith({
			type: "extension_ui_progress",
			id: "ui-9",
			answers: { auth: { selected: ["API key"] } },
		});

		overlay(fake)?.handleInput(ESC);
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("Question pending (0 unanswered)");
		await fake.submitEditorText("go with the key");
		expect(await pending).toEqual({
			type: "extension_ui_response",
			id: "ui-9",
			answers: { auth: { selected: ["API key"] } },
			comment: "go with the key",
		});
		expect(fake.session.sendUserMessage).not.toHaveBeenCalled();
		expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toBeUndefined();
	});

	it("renders the shortcut hint from the registered key", () => {
		const fake = createFakeInteractiveMode();
		void fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
		expect(stripAnsi(fake.widgetText(ASK_USER_WIDGET_KEY) ?? "")).toContain(
			process.platform === "darwin" ? "option+a" : "alt+a",
		);
	});
});
