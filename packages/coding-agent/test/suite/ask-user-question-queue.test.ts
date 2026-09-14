// Refs #1645: interactive queue ownership, focus and timeout authority.
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuestionRequest } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { ASK_USER_WIDGET_KEY } from "../../src/modes/interactive/components/ask-user-async-widget.ts";
import { AskUserQuestionComponent } from "../../src/modes/interactive/components/ask-user-question.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createFakeInteractiveMode, type FakeInteractiveMode } from "./helpers/ask-user-async-fake-mode.ts";

const NEXT = "\x1b[1;3B";
const ESC = "\x1b";
const aborts: AbortController[] = [];
function request(id: string): QuestionRequest {
	return {
		requestId: id,
		waitForAnswer: false,
		timeoutMs: 60_000,
		questions: [
			{
				id: "q",
				header: id,
				question: `Choose ${id}`,
				options: [{ label: "One" }, { label: "Two" }],
				multiSelect: false,
			},
		],
	};
}
function ask(fake: FakeInteractiveMode, id: string, getDeadlineAtMs?: () => number) {
	const controller = new AbortController();
	aborts.push(controller);
	const opts = { signal: controller.signal, getDeadlineAtMs };
	const pending = fake.createExtensionUIContext().question?.(request(id), opts);
	if (!pending) throw new Error("Question surface is missing");
	const settled = vi.fn();
	void pending.then(settled);
	return { pending, settled, abort: () => controller.abort() };
}
function widget(fake: FakeInteractiveMode) {
	return fake.widgetText(ASK_USER_WIDGET_KEY);
}
function overlay(fake: FakeInteractiveMode) {
	return fake.editorContainer.children.find((child) => child instanceof AskUserQuestionComponent);
}

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	vi.useFakeTimers();
});
afterEach(() => {
	for (const controller of aborts.splice(0)) controller.abort();
	vi.useRealTimers();
});

describe("pending-question queue", () => {
	it("retains both requests instead of cancelling the first on arrival", async () => {
		const fake = createFakeInteractiveMode();
		const first = ask(fake, "Alpha");
		ask(fake, "Beta");
		await Promise.resolve();
		expect(first.settled).not.toHaveBeenCalled();
		expect(widget(fake)).toContain("2 questions pending");
		expect(widget(fake)).toContain("Alpha");
	});
	it("preserves focus and composer text on the second arrival", () => {
		const fake = createFakeInteractiveMode();
		ask(fake, "Alpha");
		fake.editor.setText("draft");
		const focused = fake.ui.getFocusedComponent();
		ask(fake, "Beta");
		expect(fake.ui.getFocusedComponent()).toBe(focused);
		expect(fake.editor.getText()).toBe("draft");
	});
	it("settling the second leaves the first shown", async () => {
		const fake = createFakeInteractiveMode();
		ask(fake, "Alpha");
		const second = ask(fake, "Beta");
		second.abort();
		await second.pending;
		expect(widget(fake)).toContain("Alpha");
		expect(widget(fake)).not.toContain("Beta");
	});
	it("settling the first shows the next oldest without changing focus", async () => {
		const fake = createFakeInteractiveMode();
		const first = ask(fake, "Alpha");
		ask(fake, "Beta");
		const focus = fake.ui.getFocusedComponent();
		first.abort();
		await first.pending;
		expect(widget(fake)).toContain("Beta");
		expect(fake.ui.getFocusedComponent()).toBe(focus);
	});
	it("alt+down cycles only with an empty editor", () => {
		const fake = createFakeInteractiveMode();
		ask(fake, "Alpha");
		ask(fake, "Beta");
		expect(fake.pressEditorKey(NEXT)).toBe(true);
		expect(widget(fake)).toContain("Beta");
		fake.editor.setText("x");
		expect(fake.pressEditorKey(NEXT)).toBe(false);
		expect(widget(fake)).toContain("Beta");
	});
	it("settling the expanded shown request restores editor focus without expanding the next", async () => {
		const fake = createFakeInteractiveMode();
		const first = ask(fake, "Alpha");
		ask(fake, "Beta");
		await fake.submitEditorText("");
		expect(overlay(fake)).toBeDefined();
		first.abort();
		await first.pending;
		expect(overlay(fake)).toBeUndefined();
		expect(fake.ui.getFocusedComponent()).toBe(fake.editor);
		expect(widget(fake)).toContain("Beta");
	});
	it("Esc keeps both pending and preserves the explicitly shown request", async () => {
		const fake = createFakeInteractiveMode();
		const first = ask(fake, "Alpha");
		const second = ask(fake, "Beta");
		fake.pressEditorKey(NEXT);
		await fake.submitEditorText("");
		overlay(fake)?.handleInput(ESC);
		await Promise.resolve();
		expect(first.settled).not.toHaveBeenCalled();
		expect(second.settled).not.toHaveBeenCalled();
		expect(widget(fake)).toContain("2 questions pending");
		expect(widget(fake)).toContain("Beta");
	});
	it("removes the widget after the final settlement", async () => {
		const fake = createFakeInteractiveMode();
		const first = ask(fake, "Alpha");
		const second = ask(fake, "Beta");
		first.abort();
		second.abort();
		await Promise.all([first.pending, second.pending]);
		expect(widget(fake)).toBeUndefined();
	});
	it("displays an absolute deadline and observes extensions to it", () => {
		const fake = createFakeInteractiveMode();
		let deadline = Date.now() + 10 * 60_000;
		ask(fake, "Alpha", () => deadline);
		expect(widget(fake)).toContain("10m");
		deadline = Date.now() + 20 * 60_000;
		vi.advanceTimersByTime(1_000);
		expect(widget(fake)).toContain("20m");
	});
	it("retains widget-owned timeout when the deadline getter is absent", async () => {
		const fake = createFakeInteractiveMode();
		const first = ask(fake, "Alpha");
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(first.pending).resolves.toMatchObject({ status: "timed_out" });
	});
	it("never resolves a timeout when the extension owns the deadline", async () => {
		const fake = createFakeInteractiveMode();
		const deadline = Date.now() + 1_000;
		const first = ask(fake, "Alpha", () => deadline);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(first.settled).not.toHaveBeenCalled();
		expect(widget(fake)).toBeDefined();
	});
	it("expanded countdown also remains display-only with an external deadline", async () => {
		const fake = createFakeInteractiveMode();
		const first = ask(fake, "Alpha", () => Date.now() - 1);
		await fake.submitEditorText("");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(first.settled).not.toHaveBeenCalled();
		expect(overlay(fake)).toBeDefined();
	});
});
