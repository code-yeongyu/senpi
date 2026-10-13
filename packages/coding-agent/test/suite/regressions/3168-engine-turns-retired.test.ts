/**
 * The engine turn limit is gone (senpi#3168). A settings file that still carries `engineTurns`
 * loads normally: the keys are ignored in memory, removed from the GLOBAL file by the targeted raw
 * rewrite, and never rewritten out of a PROJECT file.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSettingsJson, SettingsManager } from "../../../src/core/settings-manager.ts";

let root: string;
let agentDir: string;
let cwd: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "engine-turns-retired-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const readJson = (path: string): unknown => parseSettingsJson(readFileSync(path, "utf8"));

describe("retired engineTurns settings keys (senpi#3168)", () => {
	it("removes both keys from the global file and drops the emptied parent", () => {
		const globalPath = join(agentDir, "settings.json");
		writeFileSync(
			globalPath,
			JSON.stringify({ engineTurns: { maxPerUserInput: 5, maxToolFreePerMinute: 3 }, theme: "dark" }, null, 2),
		);

		const manager = SettingsManager.create(cwd, agentDir);

		expect(readJson(globalPath)).toEqual({ theme: "dark" });
		expect(manager.getGlobalSettings()).not.toHaveProperty("engineTurns");
	});

	it("keeps unknown siblings of the retired keys", () => {
		const globalPath = join(agentDir, "settings.json");
		writeFileSync(
			globalPath,
			JSON.stringify({ engineTurns: { maxPerUserInput: 5, other: 1 }, theme: "dark" }, null, 2),
		);

		const manager = SettingsManager.create(cwd, agentDir);

		expect(readJson(globalPath)).toEqual({ engineTurns: { other: 1 }, theme: "dark" });
		expect(manager.getGlobalSettings()).toHaveProperty("engineTurns", { other: 1 });
	});

	it("never rewrites a project file, and ignores its key in memory", () => {
		const projectPath = join(cwd, ".senpi", "settings.json");
		mkdirSync(join(cwd, ".senpi"));
		writeFileSync(projectPath, JSON.stringify({ engineTurns: { maxPerUserInput: 5 }, theme: "light" }));
		const before = sha256(projectPath);

		const manager = SettingsManager.create(cwd, agentDir);

		expect(sha256(projectPath)).toBe(before);
		expect(manager.getProjectSettings()).toEqual({ theme: "light" });
	});
});
