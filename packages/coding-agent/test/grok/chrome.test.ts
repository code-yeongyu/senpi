import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { GrokChrome } from "../../src/modes/interactive/grok/chrome.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import {
	backgroundFromThemeExport,
	bg,
	fg,
	GROK_COLOR_MODES,
	initGrokTheme,
	resetGrokThemeCapabilities,
} from "./theme-assertions.ts";

function createRuntime(): AgentSessionRuntime {
	return {
		session: {
			autoCompactionEnabled: true,
			resourceLoader: { getThemes: () => ({ themes: [] }) },
			sessionManager: { getCwd: () => process.cwd() },
			settingsManager: {
				getAutocompleteMaxVisible: () => 5,
				getClearOnShrink: () => false,
				getEditorPaddingX: () => 0,
				getHideThinkingBlock: () => false,
				getOutputPad: () => 1,
				getShowHardwareCursor: () => false,
				getSmoothStreaming: () => false,
				getSmoothStreamingFps: () => 60,
				getThemeSetting: () => "grok-night",
			},
		},
		setBeforeSessionInvalidate: () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
}

for (const { label, trueColor } of GROK_COLOR_MODES) {
	describe(`GrokChrome (${label})`, () => {
		beforeEach(() => {
			expect(initGrokTheme("grok-night", trueColor)).toBe(label);
		});

		afterEach(() => {
			resetGrokThemeCapabilities();
		});

		it("selects grok tool presentation and routes the input border through active-theme chrome tokens", () => {
			const chrome = new GrokChrome();
			expect(chrome.toolPresentation).toBe("grok");
			expect(chrome.getEditorBorderColor({ isBashMode: false, thinkingLevel: "high" })("─")).toBe(
				fg("borderAccent", "─"),
			);
		});

		it("styles selected slash prefixes and rows through the active grok theme", () => {
			const chrome = new GrokChrome();
			const selectList = chrome.getEditorTheme().selectList;

			expect(selectList.selectedPrefix("→ ")).toBe(fg("accent", "→ "));
			expect(
				selectList.renderRow?.({
					prefix: selectList.selectedPrefix("→ "),
					primary: "/model",
					description: "  Select model",
					isSelected: true,
				}),
			).toBe(bg("selectedBg", `${fg("accent", "→ ")}${fg("text", "/model")}${fg("muted", "  Select model")}`));

			expect(initGrokTheme("grok-day", trueColor)).toBe(label);
			const daySelectList = chrome.getEditorTheme().selectList;
			expect(daySelectList.selectedPrefix("→ ")).toBe(fg("accent", "→ "));
			expect(
				daySelectList.renderRow?.({
					prefix: daySelectList.selectedPrefix("→ "),
					primary: "/model",
					isSelected: true,
				}),
			).toBe(bg("selectedBg", `${fg("accent", "→ ")}${fg("text", "/model")}`));
		});

		it("renders the footer surface through the active grok theme", () => {
			const chrome = new GrokChrome();
			const footer = { render: () => ["footer"], invalidate: () => {} };
			const nightFooter = chrome.arrangeRoot([footer]).at(-1);
			expect(nightFooter?.render(80)).toEqual([backgroundFromThemeExport("pageBg", "footer")]);

			expect(initGrokTheme("grok-day", trueColor)).toBe(label);
			const dayFooter = chrome.arrangeRoot([footer]).at(-1);
			expect(dayFooter?.render(80)).toEqual([backgroundFromThemeExport("pageBg", "footer")]);
		});

		it("wires the grok braille spinner into working indicators", () => {
			const chrome = new GrokChrome();
			const indicator = chrome.createWorkingIndicator(new TUI(new VirtualTerminal(80, 24)), "Working");
			try {
				expect(indicator.render(80)).toEqual([
					"",
					` ${fg("accent", "⠹")} ${fg("muted", "Working")}${" ".repeat(70)}`,
				]);
			} finally {
				indicator.dispose();
			}
		});

		it("resolves the gate's grok option to the mode-owned strategy", () => {
			const mode = new InteractiveMode(createRuntime(), { chrome: "grok" });
			expect((mode as unknown as { chrome: unknown }).chrome).toBeInstanceOf(GrokChrome);
		});
	});
}
