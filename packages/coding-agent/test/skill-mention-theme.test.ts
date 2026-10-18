import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getEditorTheme,
	initTheme,
	loadThemeFromPath,
	setThemeJsonValidator,
	theme,
} from "../src/modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../src/modes/interactive/theme/theme-json.ts";

setThemeJsonValidator(validateThemeJson);

const tempDirs: string[] = [];

function loadDarkTheme(): { name: string; colors: Record<string, string | number> } {
	return JSON.parse(readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8")) as {
		name: string;
		colors: Record<string, string | number>;
	};
}

function writeTheme(themeJson: { name: string; colors: Record<string, string | number> }): string {
	const testDir = mkdtempSync(join(tmpdir(), "pi-skill-mention-theme-"));
	tempDirs.push(testDir);
	const themePath = join(testDir, `${themeJson.name}.json`);
	writeFileSync(themePath, JSON.stringify(themeJson));
	return themePath;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("skill mention theme color", () => {
	it("falls back to mdLink when omitted", () => {
		const themeJson = loadDarkTheme();
		themeJson.name = "missing-skill-mention-theme";
		delete themeJson.colors.skillMention;

		const loadedTheme = loadThemeFromPath(writeTheme(themeJson), "truecolor");
		expect(loadedTheme.getFgAnsi("skillMention")).toBe(loadedTheme.getFgAnsi("mdLink"));
	});

	it("uses an explicitly configured skill mention color", () => {
		const themeJson = loadDarkTheme();
		themeJson.name = "custom-skill-mention-theme";
		themeJson.colors.skillMention = "#5f87ff";

		const loadedTheme = loadThemeFromPath(writeTheme(themeJson), "truecolor");
		expect(loadedTheme.getFgAnsi("skillMention")).toBe("\x1b[38;2;95;135;255m");
	});

	it("styles editor mentions bold in the skill mention color", () => {
		initTheme("dark");
		const styled = getEditorTheme().mention?.("$debugging");

		expect(styled).toBe(theme.fg("skillMention", "\x1b[1m$debugging\x1b[22m"));
		expect(styled).not.toBe(theme.fg("mdLink", "$debugging"));
	});
});
