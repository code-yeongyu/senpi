/**
 * Loader test for the `grok-night` / `grok-day` themes (todo G1).
 *
 * Both themes are loaded through the real theme-loading path
 * (`getBuiltinThemes()` → `loadThemeJson()` → `getResolvedThemeColors()`).
 * Assertions:
 *  1. The theme names resolve via the builtin registry.
 *  2. Every §Palette-named key resolves to its exact plan-table hex
 *     (`.omo/plans/grok-neo.md` §Palette).
 *  3. Every remaining schema key is present — no missing keys versus the
 *     `dark.json` (night) / `light.json` (day) coverage — and every key NOT
 *     named by §Palette inherits the corresponding dark/light value verbatim.
 */
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DynamicBorder } from "../../src/modes/interactive/components/dynamic-border.ts";
import {
	getAvailableThemes,
	getResolvedThemeColors,
	getThemeByName,
	getThemeExportColors,
} from "../../src/modes/interactive/theme/theme.ts";
import { fg, GROK_COLOR_MODES, initGrokTheme, resetGrokThemeCapabilities } from "./theme-assertions.ts";

const themeDir = new URL("../../src/modes/interactive/theme/", import.meta.url);

function readThemeJson(file: string): { name: string; colors: Record<string, string | number> } {
	return JSON.parse(fs.readFileSync(new URL(file, themeDir), "utf-8"));
}

/**
 * §Palette → ThemeColor mapping for grok-night (see plan §Palette + G1's
 * binding mapping rule). Keys not listed here must inherit dark.json values.
 */
const NIGHT_PALETTE_MAP: Record<string, string> = {
	// accents -> success/error/info-or-border/warning/path-emphasis
	success: "#9ece6a",
	error: "#f7768e",
	warning: "#e0af68",
	mdLink: "#3a95ab", // accents.cyan — path-emphasis
	// Grok Night block -> accent slots
	accent: "#7aa2f7", // grokNight.blue
	userMessageText: "#c0caf5", // grokNight.fg
	customMessageLabel: "#bb9af7", // grokNight.magenta
	// borders -> modal/input/card border keys
	border: "#585858", // borders.modal — generic modal/overlay border token
	borderAccent: "#505058", // borders.input — grok input border token
	borderMuted: "#333333", // borders.card
	// text tiers -> fg hierarchy
	text: "#e1e1e1", // text.primary
	thinkingText: "#808080", // text.label
	muted: "#6c6c6c", // text.muted
	dim: "#585858", // text.dim
	toolTitle: "#c8c8c8", // text.secondary
	customMessageText: "#c8c8c8", // text.secondary
	toolOutput: "#6c6c6c", // text.muted
	mdLinkUrl: "#505058", // text.faint
	mdCodeBlockBorder: "#808080", // text.label
	mdQuote: "#808080", // text.label
	mdQuoteBorder: "#808080", // text.label
	mdHr: "#808080", // text.label
	toolDiffContext: "#808080", // text.label
	// surfaces -> background keys
	selectedBg: "#363636", // surfaces.selected — strong selection bg
	userMessageBg: "#1c1c1c", // surfaces.altRow — alt rows
	customMessageBg: "#242424", // surfaces.highlight — menu/selection band
	// remaining accent-slot / accent consumers (semantic matches)
	mdCode: "#73daca", // grokNight.cyan (dark uses its teal-ish accent here)
	mdCodeBlock: "#9ece6a", // accents.green
	mdListBullet: "#7aa2f7", // grokNight.blue (dark uses accent here)
	toolDiffAdded: "#9ece6a", // accents.green
	toolDiffRemoved: "#f7768e", // accents.red
	bashMode: "#9ece6a", // accents.green
};

/** §Palette → ThemeColor mapping for grok-day: the Grok Day accent slots. */
const DAY_PALETTE_MAP: Record<string, string> = {
	accent: "#2F64D2", // grokDay.blue
	border: "#585858", // borders.modal — generic modal/overlay border token
	borderAccent: "#2F64D2", // grokDay.blue — grok input border token
	success: "#0C947C", // grokDay.green
	error: "#CD3048", // grokDay.red
	mdCodeBlock: "#0C947C", // grokDay.green (light routes its green here)
	mdListBullet: "#0C947C", // grokDay.green (light routes its green here)
	toolDiffAdded: "#0C947C", // grokDay.green
	toolDiffRemoved: "#CD3048", // grokDay.red
	bashMode: "#0C947C", // grokDay.green
};

const NIGHT_EXPORT_MAP: Record<string, string> = {
	pageBg: "#141414", // surfaces.base — main bg
	cardBg: "#111111", // surfaces.panel — input/lower-panel bg
	infoBg: "#242424", // surfaces.highlight — menu/selection band
};

for (const { label, trueColor } of GROK_COLOR_MODES) {
	describe(`grok themes (plan G1, ${label})`, () => {
		beforeEach(() => {
			expect(initGrokTheme("grok-night", trueColor)).toBe(label);
		});

		afterEach(() => {
			resetGrokThemeCapabilities();
		});
		it("registers grok-night and grok-day as builtin themes", () => {
			const names = getAvailableThemes();
			expect(names).toContain("grok-night");
			expect(names).toContain("grok-day");
		});

		it("loads both themes through the real loading path", () => {
			expect(getThemeByName("grok-night")?.name).toBe("grok-night");
			expect(getThemeByName("grok-day")?.name).toBe("grok-day");
		});

		it("grok-night resolves every §Palette-named key to its exact plan hex", () => {
			const resolved = getResolvedThemeColors("grok-night");
			for (const [key, hex] of Object.entries(NIGHT_PALETTE_MAP)) {
				expect(resolved[key], `grok-night ${key}`).toBe(hex);
			}
			expect(getThemeExportColors("grok-night")).toEqual(NIGHT_EXPORT_MAP);
		});

		it("grok-day resolves every §Palette-named key to its exact plan hex", () => {
			const resolved = getResolvedThemeColors("grok-day");
			for (const [key, hex] of Object.entries(DAY_PALETTE_MAP)) {
				expect(resolved[key], `grok-day ${key}`).toBe(hex);
			}
		});

		it("routes generic modal overlays through the normal border token", () => {
			for (const themeName of ["grok-night", "grok-day"] as const) {
				expect(initGrokTheme(themeName, trueColor)).toBe(label);
				expect(getResolvedThemeColors(themeName).border, `${themeName} modal border`).toBe("#585858");
				expect(new DynamicBorder().render(3)).toEqual([fg("border", "───")]);
			}
		});

		it("grok-night covers every dark.json key and inherits non-§Palette keys verbatim", () => {
			const darkJson = readThemeJson("dark.json");
			const nightJson = readThemeJson("grok-night.json");
			// No missing keys versus dark.json.
			expect(Object.keys(nightJson.colors).sort()).toEqual(Object.keys(darkJson.colors).sort());
			// Keys not named by §Palette inherit the resolved dark.json value verbatim.
			const darkResolved = getResolvedThemeColors("dark");
			const nightResolved = getResolvedThemeColors("grok-night");
			for (const key of Object.keys(darkJson.colors)) {
				if (!(key in NIGHT_PALETTE_MAP)) {
					expect(nightResolved[key], `grok-night inherits dark ${key}`).toBe(darkResolved[key]);
				}
			}
		});

		it("grok-day covers every light.json key and inherits non-§Palette keys verbatim", () => {
			const lightJson = readThemeJson("light.json");
			const dayJson = readThemeJson("grok-day.json");
			// No missing keys versus light.json.
			expect(Object.keys(dayJson.colors).sort()).toEqual(Object.keys(lightJson.colors).sort());
			// Keys not named by §Palette inherit the resolved light.json value verbatim.
			const lightResolved = getResolvedThemeColors("light");
			const dayResolved = getResolvedThemeColors("grok-day");
			for (const key of Object.keys(lightJson.colors)) {
				if (!(key in DAY_PALETTE_MAP)) {
					expect(dayResolved[key], `grok-day inherits light ${key}`).toBe(lightResolved[key]);
				}
			}
			// Export backgrounds are not §Palette-named for day: inherit light verbatim.
			const lightExport = getThemeExportColors("light");
			expect(getThemeExportColors("grok-day")).toEqual(lightExport);
		});
	});
}
