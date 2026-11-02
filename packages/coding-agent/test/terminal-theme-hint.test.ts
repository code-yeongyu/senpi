import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readTerminalThemeHint, writeTerminalThemeHint } from "../src/modes/interactive/theme/terminal-theme-cache.ts";

describe("terminal theme hint", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "senpi-theme-hint-"));
	});

	afterEach(() => {
		rmSync(agentDir, { force: true, recursive: true });
	});

	test("#given a detected terminal theme #when it is written and read back #then the value survives", () => {
		// Given / When
		writeTerminalThemeHint("light", agentDir);
		// Then
		expect(readTerminalThemeHint(agentDir)).toBe("light");
	});

	test("#given no hint on disk #when it is read #then nothing is returned", () => {
		// Given / When / Then
		expect(readTerminalThemeHint(agentDir)).toBeUndefined();
	});

	test("#given a corrupt hint file #when it is read #then nothing is returned and nothing throws", () => {
		// Given
		mkdirSync(join(agentDir, "cache"), { recursive: true });
		writeFileSync(join(agentDir, "cache", "terminal-theme.json"), "{ not json");
		// When / Then
		expect(readTerminalThemeHint(agentDir)).toBeUndefined();
	});

	test("#given a hint naming an unknown theme #when it is read #then it is rejected", () => {
		// Given
		mkdirSync(join(agentDir, "cache"), { recursive: true });
		writeFileSync(join(agentDir, "cache", "terminal-theme.json"), JSON.stringify({ terminalTheme: "sepia" }));
		// When / Then
		expect(readTerminalThemeHint(agentDir)).toBeUndefined();
	});

	test("#given an unwritable agent directory #when a hint is written #then the launch is not broken", () => {
		// Given
		const unwritable = join(agentDir, "missing", "\0invalid");
		// When / Then
		expect(() => writeTerminalThemeHint("dark", unwritable)).not.toThrow();
	});
});
