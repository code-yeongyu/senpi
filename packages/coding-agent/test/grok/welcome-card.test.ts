import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GrokWelcomeCard } from "../../src/modes/interactive/grok/welcome-card.ts";
import {
	backgroundFromThemeExport,
	fg,
	GROK_COLOR_MODES,
	initGrokTheme,
	resetGrokThemeCapabilities,
} from "./theme-assertions.ts";

for (const { label, trueColor } of GROK_COLOR_MODES) {
	describe(`GrokWelcomeCard (${label})`, () => {
		beforeEach(() => {
			expect(initGrokTheme("grok-night", trueColor)).toBe(label);
		});

		afterEach(() => {
			resetGrokThemeCapabilities();
		});

		it("resolves the card border from the active theme", () => {
			const card = new GrokWelcomeCard("senpi", "9.9.9");
			expect(card.render(30)).toEqual([
				fg("borderMuted", "╭────────────────────────────╮"),
				`${fg("borderMuted", "│")}${backgroundFromThemeExport("cardBg", ` ${fg("text", "senpi v9.9.9")}               `)}${fg("borderMuted", "│")}`,
				`${fg("borderMuted", "│")}${backgroundFromThemeExport("cardBg", " Ready for your next task.  ")}${fg("borderMuted", "│")}`,
				fg("borderMuted", "╰────────────────────────────╯"),
			]);
		});
	});
}
