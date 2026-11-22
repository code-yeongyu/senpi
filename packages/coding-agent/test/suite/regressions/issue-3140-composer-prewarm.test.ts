import { Editor, TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import { emitUserActivity } from "../../../src/core/extensions/user-activity.ts";
import { observeComposerActivity } from "../../../src/modes/interactive/composer-user-activity.ts";
import { getEditorTheme, initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { submitsCommandAsText } from "../../../src/modes/interactive/unknown-command-feedback.ts";
import { cleanupPrewarmHarnesses, createPrewarmHarness, within } from "../prompt-cache-prewarm-harness.ts";

describe("composer first activity prewarm (#3140)", () => {
	afterEach(() => {
		cleanupPrewarmHarnesses();
		vi.useRealTimers();
	});

	it("prewarms exactly once on the first actual composer keystroke", async () => {
		vi.useFakeTimers();
		initTheme("dark");
		const warm = vi.fn(async () => ({ supported: false as const }));
		const { harness, warmCalled } = await createPrewarmHarness(warm);
		const editor = new Editor(new TUI(new VirtualTerminal(80, 24)), getEditorTheme());
		observeComposerActivity(editor, () => emitUserActivity(harness.session, "draft"));
		await harness.session.bindExtensions({});
		await vi.runAllTimersAsync();
		expect(warm).not.toHaveBeenCalled();

		editor.handleInput("h");
		await within(warmCalled, "first keystroke prewarm");
		editor.handleInput("i");
		await vi.runAllTimersAsync();

		expect(editor.getText()).toBe("hi");
		expect(warm).toHaveBeenCalledTimes(1);
	});

	it("does not count draft restoration or cursor movement as user activity", async () => {
		vi.useFakeTimers();
		initTheme("dark");
		const warm = vi.fn(async () => ({ supported: false as const }));
		const { harness } = await createPrewarmHarness(warm);
		const editor = new Editor(new TUI(new VirtualTerminal(80, 24)), getEditorTheme());
		observeComposerActivity(editor, () => emitUserActivity(harness.session, "draft"));
		await harness.session.bindExtensions({});

		editor.setText("restored draft");
		editor.handleInput("\x1b[D");
		await vi.runAllTimersAsync();

		expect(warm).not.toHaveBeenCalled();
	});

	it("does not prewarm when the user types with keep-alive disabled", async () => {
		vi.useFakeTimers();
		initTheme("dark");
		const warm = vi.fn(async () => ({ supported: false as const }));
		const { harness } = await createPrewarmHarness(warm, {
			settings: { promptCache: { keepAlive: { enabled: false } } },
		});
		const editor = new Editor(new TUI(new VirtualTerminal(80, 24)), getEditorTheme());
		observeComposerActivity(editor, () => emitUserActivity(harness.session, "draft"));
		await harness.session.bindExtensions({});

		editor.handleInput("h");
		await vi.runAllTimersAsync();

		expect(warm).not.toHaveBeenCalled();
	});

	it("counts deleting a restored draft as real activity", async () => {
		vi.useFakeTimers();
		initTheme("dark");
		const warm = vi.fn(async () => ({ supported: false as const }));
		const { harness, warmCalled } = await createPrewarmHarness(warm);
		const editor = new Editor(new TUI(new VirtualTerminal(80, 24)), getEditorTheme());
		observeComposerActivity(editor, () => emitUserActivity(harness.session, "draft"));
		await harness.session.bindExtensions({});
		await vi.runAllTimersAsync();
		expect(warm).not.toHaveBeenCalled();
		editor.setText("h");

		editor.handleInput("\x7f");
		await within(warmCalled, "draft deletion prewarm");

		expect(editor.getText()).toBe("");
		expect(warm).toHaveBeenCalledTimes(1);
	});

	it("preserves leading-space slash escape through wrapped input submission", () => {
		initTheme("dark");
		const editor = new Editor(new TUI(new VirtualTerminal(80, 24)), getEditorTheme());
		const submitted = vi.fn();
		let escaped = false;
		editor.onSubmit = (text, details) => {
			submitted(text, details);
			escaped = submitsCommandAsText(text, details);
		};
		observeComposerActivity(editor, () => {});
		editor.handleInput(" /foo bar");

		editor.handleInput("\r");

		expect(submitted).toHaveBeenCalledWith("/foo bar", { rawText: " /foo bar" });
		expect(escaped).toBe(true);
	});

	it("does not publish draft activity for submit-time clearing", () => {
		initTheme("dark");
		const editor = new Editor(new TUI(new VirtualTerminal(80, 24)), getEditorTheme());
		const activity = vi.fn();
		const submitted = vi.fn();
		editor.onSubmit = submitted;
		observeComposerActivity(editor, activity);
		editor.setText("hello");

		editor.handleInput("\r");

		expect(submitted).toHaveBeenCalledWith("hello", { rawText: "hello" });
		expect(activity).not.toHaveBeenCalled();
	});
});
