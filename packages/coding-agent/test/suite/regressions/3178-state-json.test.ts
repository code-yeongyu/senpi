import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../../src/config.ts";
import {
	excludeRoutineOnlySettingsChanges,
	isSettingsPath,
	refreshSettingsContentSnapshots,
} from "../../../src/core/extensions/builtin/config-reload/routine-settings.ts";
import {
	FileSettingsStorage,
	InMemorySettingsStorage,
	SettingsManager,
	type SettingsStorage,
} from "../../../src/core/settings-manager.ts";

describe("3178 config and state separation", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	let settingsPath: string;
	let statePath: string;
	const config = '{\n "theme": "dark", "defaultModel": "example", "favoriteModels": ["faux/example:high"]\n}\n';

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "senpi-3178-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir);
		mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
		settingsPath = join(agentDir, "settings.json");
		statePath = join(agentDir, "state.json");
		writeFileSync(settingsPath, config);
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it.each([
		[
			"tip shown",
			(manager: SettingsManager) => manager.setTipShown("example", 123),
			{ tipsHistory: { example: 123 } },
		],
		[
			"tip history",
			(manager: SettingsManager) => manager.setTipsHistory({ example: 123 }),
			{ tipsHistory: { example: 123 } },
		],
		[
			"changelog acknowledged",
			(manager: SettingsManager) => manager.setChangelogSeen("engine", "1.2"),
			{ changelogSeen: { engine: "1.2" } },
		],
		[
			"legacy changelog",
			(manager: SettingsManager) => manager.setLastChangelogVersion("1.2"),
			{ lastChangelogVersion: "1.2" },
		],
		[
			"reasoning effort",
			(manager: SettingsManager) => manager.setModelThinkingLevel("faux", "example", "high"),
			{ modelThinkingLevels: { "faux/example": "high" }, modelLastOnThinkingLevels: { "faux/example": "high" } },
		],
		[
			"reasoning restore",
			(manager: SettingsManager) => manager.setModelLastOnThinkingLevel("faux", "example", "low"),
			{ modelLastOnThinkingLevels: { "faux/example": "low" } },
		],
		[
			"fast mode",
			(manager: SettingsManager) => manager.setModelServiceTier("faux", "example", "priority"),
			{ modelServiceTiers: { "faux/example": "priority" } },
		],
	] as const)("keeps config byte-identical after %s", async (_name, update, expected) => {
		const manager = SettingsManager.create(cwd, agentDir);
		update(manager);
		await manager.flush();
		expect(manager.drainErrors()).toEqual([]);
		expect(readFileSync(settingsPath, "utf8")).toBe(config);
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(expected);
	});

	it("leaves a no-value-change config save byte-identical", async () => {
		const manager = SettingsManager.create(cwd, agentDir);
		manager.setTheme("dark");
		await manager.flush();
		expect(readFileSync(settingsPath, "utf8")).toBe(config);
	});

	it("migrates all six keys once without normalizing other keys or changing their order", () => {
		const state = {
			tipsHistory: { example: 123 },
			changelogSeen: { engine: "1.2" },
			lastChangelogVersion: "1.1",
			modelThinkingLevels: { "faux/example": "high" },
			modelLastOnThinkingLevels: { "faux/example": "low" },
			modelServiceTiers: { "faux/example": "priority" },
		};
		const remaining = { zCustom: { nested: [1, 2] }, queueMode: "all", retry: { maxDelayMs: 123 }, theme: "dark" };
		const { zCustom, ...rest } = remaining;
		writeFileSync(settingsPath, JSON.stringify({ zCustom, ...state, ...rest }));
		const manager = SettingsManager.create(cwd, agentDir);
		expect(manager.getTipsHistory()).toEqual(state.tipsHistory);
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(state);
		expect(readFileSync(settingsPath, "utf8")).toBe(JSON.stringify(remaining, null, 2));
		const stateBefore = readFileSync(statePath, "utf8");
		const configBefore = readFileSync(settingsPath, "utf8");
		SettingsManager.create(cwd, agentDir);
		expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
		expect(readFileSync(settingsPath, "utf8")).toBe(configBefore);
	});

	it("keeps existing state keys while migrating only missing keys", () => {
		writeFileSync(
			settingsPath,
			JSON.stringify({ tipsHistory: { old: 1 }, changelogSeen: { engine: "1.2" }, theme: "dark" }),
		);
		writeFileSync(statePath, JSON.stringify({ tipsHistory: { current: 2 } }));
		const manager = SettingsManager.create(cwd, agentDir);
		expect(manager.getTipsHistory()).toEqual({ current: 2 });
		expect(manager.getChangelogSeen()).toBe("1.2");
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
			tipsHistory: { current: 2 },
			changelogSeen: { engine: "1.2" },
		});
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ theme: "dark" });
	});

	it("loads state even when no global settings file exists", () => {
		rmSync(settingsPath);
		writeFileSync(statePath, JSON.stringify({ tipsHistory: { example: 123 }, theme: "light" }));
		const manager = SettingsManager.create(cwd, agentDir);
		expect(manager.getTipsHistory()).toEqual({ example: 123 });
		expect(manager.getTheme()).toBeUndefined();
		expect(existsSync(settingsPath)).toBe(false);
	});

	it("falls back to legacy settings when a state migration write fails", () => {
		writeFileSync(settingsPath, JSON.stringify({ tipsHistory: { legacy: 123 } }));
		const files = new FileSettingsStorage(cwd, agentDir);
		const storage: SettingsStorage & {
			withStateLock: (fn: (current: string | undefined) => string | undefined) => void;
		} = {
			withLock: (scope, fn) => files.withLock(scope, fn),
			withStateLock: (fn) => {
				const next = fn(undefined);
				if (next !== undefined) throw new Error("synthetic state write failure");
			},
		};
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getTipsHistory()).toEqual({ legacy: 123 });
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ tipsHistory: { legacy: 123 } });
	});

	it("does not migrate project keys or rewrite project settings during global state saves", async () => {
		const projectPath = join(cwd, CONFIG_DIR_NAME, "settings.json");
		const project = '{"tipsHistory":{"project":7},"theme":"light"}\n';
		writeFileSync(projectPath, project);
		const manager = SettingsManager.create(cwd, agentDir);
		manager.setChangelogSeen("engine", "1.2");
		await manager.flush();
		expect(readFileSync(projectPath, "utf8")).toBe(project);
		expect(readFileSync(settingsPath, "utf8")).toBe(config);
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ changelogSeen: { engine: "1.2" } });
	});

	it("merges concurrent nested state writes and preserves deletion", async () => {
		const first = SettingsManager.create(cwd, agentDir);
		const second = SettingsManager.create(cwd, agentDir);
		first.setModelThinkingLevel("faux", "first", "high");
		second.setModelThinkingLevel("faux", "second", "low");
		await Promise.all([first.flush(), second.flush()]);
		first.setModelThinkingLevel("faux", "first", undefined);
		await first.flush();
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
			modelThinkingLevels: { "faux/second": "low" },
			modelLastOnThinkingLevels: { "faux/second": "low" },
		});
		expect(readFileSync(settingsPath, "utf8")).toBe(config);
	});

	it("retains the legacy persistence contract for third-party storage without state methods", async () => {
		let global = '{"theme":"dark"}';
		const storage: SettingsStorage = {
			withLock: (scope, fn) => {
				const next = fn(scope === "global" ? global : undefined);
				if (scope === "global" && next !== undefined) global = next;
			},
		};
		const manager = SettingsManager.fromStorage(storage);
		manager.setTipShown("example", 123);
		await manager.flush();
		expect(JSON.parse(global)).toEqual({ theme: "dark", tipsHistory: { example: 123 } });
	});

	it("round-trips state through the in-memory storage backend", async () => {
		const storage = new InMemorySettingsStorage();
		const manager = SettingsManager.fromStorage(storage);
		manager.setTipShown("example", 123);
		manager.setModelServiceTier("faux", "example", "priority");
		await manager.flush();
		const loaded = SettingsManager.fromStorage(storage);
		expect(loaded.getTipsHistory()).toEqual({ example: 123 });
		expect(loaded.getModelServiceTier("faux", "example")).toBe("priority");
		let global: string | undefined;
		storage.withLock("global", (current) => {
			global = current;
			return undefined;
		});
		expect(global).toBeUndefined();
	});

	it.each([
		["live startup default", { defaultModel: "other" }, false],
		["legacy bookkeeping", { tipsHistory: { example: 123 } }, true],
		["structural settings", { extensions: ["./extension.ts"] }, true],
	] as const)("classifies an external %s edit", (_name, changed, reload) => {
		const contents = new Map<string, string>();
		refreshSettingsContentSnapshots(contents, agentDir, cwd);
		writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(config), ...changed }));
		const log = () => ({ written: true, disabled: false });
		expect(
			excludeRoutineOnlySettingsChanges([settingsPath], contents, agentDir, cwd, {
				debug: log,
				info: log,
				warn: log,
				error: log,
			}),
		).toEqual(reload ? [settingsPath] : []);
	});

	it("does not identify state.json as a watched settings path", () => {
		expect(isSettingsPath(statePath, agentDir, cwd)).toBe(false);
	});
});
