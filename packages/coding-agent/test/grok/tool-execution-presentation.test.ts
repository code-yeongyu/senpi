import { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { fg, GROK_COLOR_MODES, initGrokTheme, resetGrokThemeCapabilities } from "./theme-assertions.ts";

for (const { label, trueColor } of GROK_COLOR_MODES) {
	describe(`ToolExecutionComponent grok presentation (${label})`, () => {
		beforeEach(() => {
			expect(initGrokTheme("grok-night", trueColor)).toBe(label);
		});

		afterEach(() => {
			resetGrokThemeCapabilities();
		});

		it("uses the optional grok presentation without changing the default classic constructor contract", () => {
			const component = new ToolExecutionComponent(
				"write",
				"call-1",
				{ path: "note.txt" },
				{},
				undefined,
				new TUI(new VirtualTerminal(80, 24)),
				"/tmp",
				"grok",
			);
			try {
				expect(component.render(80)).toEqual([
					"",
					`${fg("muted", "┃")} ${fg("warning", "⠹")} ${fg("text", "write")}`,
				]);
			} finally {
				component.dispose();
			}
		});
	});
}
