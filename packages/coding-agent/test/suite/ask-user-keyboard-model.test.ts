// Refs #1645: exercise the actual CustomEditor -> host -> question dispatch path.
import { SelectList, setKeybindings, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEditorTheme } from "../../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { QuestionRequest } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { AskUserQuestionComponent } from "../../src/modes/interactive/components/ask-user-question.ts";
import { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import { WorkingStatusIndicator } from "../../src/modes/interactive/components/status-indicator.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createFakeInteractiveMode } from "./helpers/ask-user-async-fake-mode.ts";

const ENTER = "\r";
const ALT_ENTER = "\x1b\r";
const UP = "\x1b[A";
const aborts: AbortController[] = [];
const disposals: Array<() => void> = [];
function mount(embedWorkingStatus = false) {
	const fake = createFakeInteractiveMode({ isStreaming: true });
	const kb = new KeybindingsManager();
	setKeybindings(kb);
	const ui = new TuiMainScreen(new VirtualTerminal());
	const editor = new CustomEditor(ui, defaultEditorTheme, kb, { embedWorkingStatus });
	Object.assign(fake, { ui, editor, defaultEditor: editor, keybindings: kb, updateShortcutOverlay: vi.fn() });
	fake.editorContainer.clear();
	fake.editorContainer.addChild(editor);
	ui.setFocus(editor);
	editor.onExtensionShortcut = (data) => fake.handleAskUserShortcut(data);
	(fake as unknown as { setupKeyHandlers(): void }).setupKeyHandlers();
	fake.setupEditorSubmitHandler();
	disposals.push(() => ui.stop());
	const ask = (header = "Auth", count = 1) => {
		const controller = new AbortController();
		aborts.push(controller);
		const request: QuestionRequest = {
			requestId: header,
			waitForAnswer: false,
			timeoutMs: 60_000,
			questions: Array.from({ length: count }, (_, i) => ({
				id: `q${i}`,
				header: `${header}${i || ""}`,
				question: `Choose ${header} ${i}`,
				options: [{ label: "OAuth" }, { label: "API key" }, { label: "Other service" }],
				multiSelect: false,
			})),
		};
		const pending = fake.createExtensionUIContext().question?.(request, { signal: controller.signal });
		if (!pending) throw new Error("Missing question UI");
		const settled = vi.fn();
		void pending.then(settled);
		return { pending, settled, abort: () => controller.abort() };
	};
	return {
		fake,
		ui,
		editor,
		ask,
		overlay: () => fake.editorContainer.children.find((c) => c instanceof AskUserQuestionComponent),
		border: () => stripAnsi(editor.render(120)[0] ?? ""),
	};
}
beforeEach(() => {
	initTheme("dark");
	vi.useFakeTimers();
});
afterEach(() => {
	for (const c of aborts.splice(0)) c.abort();
	for (const dispose of disposals.splice(0)) dispose();
	vi.useRealTimers();
});
describe("pending-question keyboard model", () => {
	it("digit 2 on the empty composer selects and submits in the same key", async () => {
		const h = mount();
		const q = h.ask();
		h.editor.handleInput("2");
		await Promise.resolve();
		expect(q.settled).toHaveBeenCalledWith(
			expect.objectContaining({ status: "answered", answers: { q0: { selected: ["API key"] } } }),
		);
		expect(h.editor.getText()).toBe("");
		expect(h.overlay()).toBeUndefined();
	});
	it("digit mounts a two-question component, selects first and advances", () => {
		const h = mount();
		const q = h.ask("Auth", 2);
		h.editor.handleInput("2");
		expect(h.overlay()).toBeInstanceOf(AskUserQuestionComponent);
		expect(stripAnsi(h.overlay()!.render(120).join("\n"))).toContain("Choose Auth 1");
		expect(q.settled).not.toHaveBeenCalled();
		expect(h.editor.getText()).toBe("");
	});
	it("digits after existing text remain text", () => {
		const h = mount();
		h.editor.setText("x");
		h.ask();
		h.editor.handleInput("2");
		expect(h.editor.getText()).toBe("x2");
		expect(h.overlay()).toBeUndefined();
	});
	it("a digit in an already expanded async single question submits immediately", async () => {
		const h = mount();
		const q = h.ask();
		await h.fake.submitEditorText("");
		h.overlay()!.handleInput("1");
		await Promise.resolve();
		expect(q.settled).toHaveBeenCalledWith(expect.objectContaining({ status: "answered" }));
	});
	it.each([true, false])(
		"/answer skip cancels only the shown request and acknowledges it while streaming=%s",
		async (isStreaming) => {
			const h = mount();
			h.fake.session.isStreaming = isStreaming;
			const first = h.ask();
			const second = h.ask("Deploy");
			await h.fake.submitEditorText("/answer skip");
			await Promise.resolve();
			expect(first.settled).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }));
			expect(second.settled).not.toHaveBeenCalled();
			expect(h.fake.session.sendUserMessage).toHaveBeenCalledExactlyOnceWith(
				"[Answer to question Auth]\nThe user dismissed the question.",
				{ deliverAs: isStreaming ? "steer" : "followUp" },
			);
		},
	);
	it("/answer with two requests opens a two-row SelectList", async () => {
		const h = mount();
		h.ask();
		h.ask("Deploy");
		await h.fake.submitEditorText("/answer");
		const list = h.ui.getFocusedComponent();
		expect(list).toBeInstanceOf(SelectList);
		expect(list!.render(120)).toHaveLength(2);
	});
	it("/answer 2 selects and expands the second request", async () => {
		const h = mount();
		h.ask();
		h.ask("Deploy");
		await h.fake.submitEditorText("/answer 2");
		expect(stripAnsi(h.overlay()!.render(120).join("\n"))).toContain("Choose Deploy");
	});
	it("first printable text binds a label that later arrivals cannot replace", () => {
		const h = mount();
		h.ask();
		h.editor.handleInput("h");
		const border = h.border();
		h.ask("Deploy");
		expect(border).toContain("reply to Auth");
		expect(h.border()).toBe(border);
	});
	it("settling the bound request preserves its text and next Enter sends chat", async () => {
		const h = mount();
		const first = h.ask();
		h.editor.handleInput("h");
		h.ask("Deploy");
		first.abort();
		await first.pending;
		expect(h.editor.getText()).toBe("h");
		expect(h.border()).not.toContain("reply to");
		h.editor.handleInput(ENTER);
		await Promise.resolve();
		expect(h.fake.session.prompt).toHaveBeenCalledWith("h", expect.objectContaining({ streamingBehavior: "steer" }));
	});
	it("alt+enter sends a bound reply as an ordinary follow-up", async () => {
		const h = mount();
		const q = h.ask();
		h.editor.handleInput("h");
		h.editor.handleInput(ALT_ENTER);
		await Promise.resolve();
		expect(h.fake.session.prompt).toHaveBeenCalledWith(
			"h",
			expect.objectContaining({ streamingBehavior: "followUp" }),
		);
		expect(q.settled).not.toHaveBeenCalled();
		expect(h.border()).not.toContain("reply to");
	});
	it("an out-of-range digit inserts and binds rather than selecting", () => {
		const h = mount();
		h.ask();
		h.editor.handleInput("7");
		expect(h.editor.getText()).toBe("7");
		expect(h.border()).toContain("reply to Auth");
	});
	it("bracketed paste into an empty composer binds the reply", () => {
		const h = mount();
		h.ask();
		h.editor.handleInput("\x1b[200~hello\x1b[201~");
		expect(h.editor.getText()).toBe("hello");
		expect(h.border()).toContain("reply to Auth");
	});
	it("history recall never binds composer text", async () => {
		const h = mount();
		h.editor.addToHistory("old prompt");
		const q = h.ask();
		h.editor.handleInput(UP);
		h.editor.handleInput(ENTER);
		await Promise.resolve();
		expect(h.fake.session.prompt).toHaveBeenCalledWith(
			"old prompt",
			expect.objectContaining({ streamingBehavior: "steer" }),
		);
		expect(q.settled).not.toHaveBeenCalled();
	});
	it("bound reply label takes precedence over embedded working status", () => {
		const h = mount(true);
		const indicator = new WorkingStatusIndicator(h.ui, "WORKING-SENTINEL");
		disposals.push(() => indicator.dispose());
		h.editor.setWorkingStatusIndicator(indicator);
		expect(h.border()).toContain("WORKING-SENTINEL");
		h.ask();
		h.editor.handleInput("h");
		expect(h.border()).toContain("reply to Auth");
		expect(h.border()).not.toContain("WORKING-SENTINEL");
	});
});
