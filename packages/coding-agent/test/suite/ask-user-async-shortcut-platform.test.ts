import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { QuestionRequest } from "../../src/core/extensions/types.ts";
import {
	ASK_USER_WIDGET_KEY,
	matchesAskUserAnswerKey,
} from "../../src/modes/interactive/components/ask-user-async-widget.ts";
import { AskUserQuestionComponent } from "../../src/modes/interactive/components/ask-user-question.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createFakeInteractiveMode, type FakeInteractiveMode } from "./helpers/ask-user-async-fake-mode.ts";

const ALT_A = "\x1ba";
/** What Option+A types in a macOS terminal that lets Option compose (Terminal.app, iTerm2, Ghostty, kitty defaults). */
const OPTION_A_GLYPH = "å";
const OPTION_SHIFT_A_GLYPH = "Å";
/** The same glyph reported as a CSI-u printable while the kitty keyboard protocol is active. */
const KITTY_OPTION_A_GLYPH = "\x1b[229u";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { value: platform, configurable: true, enumerable: true });
}

function buildRequest(): QuestionRequest {
	return {
		requestId: "req-platform",
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

function overlay(fake: FakeInteractiveMode): AskUserQuestionComponent | undefined {
	return fake.editorContainer.children.find((child) => child instanceof AskUserQuestionComponent);
}

function askPending(fake: FakeInteractiveMode): void {
	const pending = fake.createExtensionUIContext().question?.(buildRequest(), { timeout: 30 * 60_000 });
	if (!pending) throw new Error("question() returned nothing");
}

afterEach(() => {
	if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
	else Reflect.deleteProperty(process, "platform");
});

describe("OS-aware async ask-user answer shortcut", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	describe("matchesAskUserAnswerKey", () => {
		it.each<NodeJS.Platform>(["darwin", "linux", "win32"])("accepts alt+a as ESC a on %s", (platform) => {
			expect(matchesAskUserAnswerKey(ALT_A, platform)).toBe(true);
		});

		it("accepts the Option-composed glyphs for the a key on darwin only", () => {
			expect(matchesAskUserAnswerKey(OPTION_A_GLYPH, "darwin")).toBe(true);
			expect(matchesAskUserAnswerKey(OPTION_SHIFT_A_GLYPH, "darwin")).toBe(true);
			expect(matchesAskUserAnswerKey(KITTY_OPTION_A_GLYPH, "darwin")).toBe(true);
			expect(matchesAskUserAnswerKey(OPTION_A_GLYPH, "linux")).toBe(false);
			expect(matchesAskUserAnswerKey(OPTION_A_GLYPH, "win32")).toBe(false);
		});

		it("never treats plain or multi-character text as the shortcut", () => {
			expect(matchesAskUserAnswerKey("a", "darwin")).toBe(false);
			expect(matchesAskUserAnswerKey("åå", "darwin")).toBe(false);
			expect(matchesAskUserAnswerKey("", "darwin")).toBe(false);
		});
	});

	describe("editor shortcut", () => {
		it("expands the pending question when Option+A arrives as å on darwin", () => {
			setPlatform("darwin");
			const fake = createFakeInteractiveMode({ isStreaming: true });
			askPending(fake);

			expect(fake.pressEditorKey(OPTION_A_GLYPH)).toBe(true);
			const component = overlay(fake);
			expect(component).toBeInstanceOf(AskUserQuestionComponent);
			expect(fake.ui.setFocus).toHaveBeenLastCalledWith(component);
		});

		it("still expands the pending question on ESC a on darwin", () => {
			setPlatform("darwin");
			const fake = createFakeInteractiveMode({ isStreaming: true });
			askPending(fake);

			expect(fake.pressEditorKey(ALT_A)).toBe(true);
			expect(overlay(fake)).toBeInstanceOf(AskUserQuestionComponent);
		});

		it("leaves å as ordinary editor text on linux", () => {
			setPlatform("linux");
			const fake = createFakeInteractiveMode({ isStreaming: true });
			askPending(fake);

			expect(fake.pressEditorKey(OPTION_A_GLYPH)).toBe(false);
			expect(overlay(fake)).toBeUndefined();
			expect(fake.widgetText(ASK_USER_WIDGET_KEY)).toContain("Question pending (1 unanswered)");
		});
	});

	describe("widget label", () => {
		it.each<[NodeJS.Platform, string]>([
			["darwin", "option+a"],
			["linux", "alt+a"],
			["win32", "alt+a"],
		])("names the shortcut %s as %s", (platform, label) => {
			setPlatform(platform);
			const fake = createFakeInteractiveMode();
			askPending(fake);

			expect(stripAnsi(fake.widgetText(ASK_USER_WIDGET_KEY) ?? "")).toContain(`${label} to answer`);
		});
	});
});
