import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getGrokChromeTokens } from "../../src/modes/interactive/grok/chrome-tokens.ts";
import { GrokInputCard } from "../../src/modes/interactive/grok/input-card.ts";
import {
	backgroundFromThemeExport,
	fg,
	GROK_COLOR_MODES,
	initGrokTheme,
	resetGrokThemeCapabilities,
} from "./theme-assertions.ts";

const editor: Component = {
	render: () => ["draft"],
	invalidate: () => {},
};

for (const { label, trueColor } of GROK_COLOR_MODES) {
	describe(`GrokInputCard (${label})`, () => {
		beforeEach(() => {
			expect(initGrokTheme("grok-night", trueColor)).toBe(label);
		});

		afterEach(() => {
			resetGrokThemeCapabilities();
		});

		it("resolves the grok-night input border and panel interior from active-theme chrome tokens", () => {
			const tokens = getGrokChromeTokens();
			expect(tokens.inputBorder("x")).toBe(fg("borderAccent", "x"));
			expect(tokens.inputInterior("x")).toBe(backgroundFromThemeExport("cardBg", "x"));
		});

		it("resolves day-theme chrome tokens instead of retaining grok-night literals", () => {
			expect(initGrokTheme("grok-day", trueColor)).toBe(label);
			const tokens = getGrokChromeTokens();
			expect(tokens.inputBorder("x")).toBe(fg("borderAccent", "x"));
			expect(tokens.inputInterior("x")).toBe(backgroundFromThemeExport("cardBg", "x"));
		});

		it("renders a rounded bordered card around the editor", () => {
			const card = new GrokInputCard(editor);
			expect(card.render(12)).toEqual([
				fg("borderAccent", "╭──────────╮"),
				`${fg("borderAccent", "│")}${backgroundFromThemeExport("cardBg", "draft     ")}${fg("borderAccent", "│")}`,
				fg("borderAccent", "╰──────────╯"),
			]);
		});
	});
}
