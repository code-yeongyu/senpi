import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import configReloadExtension from "../../../src/core/extensions/builtin/config-reload/index.ts";
import type { WatchEventListener } from "../../../src/core/extensions/builtin/config-reload/watch-engine.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createHarness, createTestUiContext, type Harness } from "../harness.ts";

describe("3178 session state writes", () => {
	const harnesses: Harness[] = [];
	const agentDirs: string[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		vi.useRealTimers();
		for (const path of agentDirs.splice(0)) rmSync(path, { recursive: true, force: true });
	});

	it("keeps config bytes while cycling models and remembering their reasoning and tiers", async () => {
		const harness = await createHarness({
			fileSettings: true,
			models: [
				{ id: "first", reasoning: true },
				{ id: "second", reasoning: true },
			],
			settings: {
				defaultThinkingLevel: "high",
				modelThinkingLevels: { "faux/first": "high", "faux/second": "low" },
			},
		});
		harnesses.push(harness);
		const first = harness.getModel("first");
		const second = harness.getModel("second");
		if (!first || !second) throw new Error("Missing fixture model");
		harness.session.setFavoriteModels([{ model: first }, { model: second }]);
		const configPath = join(harness.tempDir, "agent", "settings.json");
		const before = readFileSync(configPath, "utf8");

		await harness.session.cycleModel("forward", { persistDefault: false });
		expect(harness.session.model?.id).toBe("second");
		expect(harness.session.thinkingLevel).toBe("low");
		harness.settingsManager.setModelServiceTier("faux", "second", "priority");
		await harness.settingsManager.flush();

		expect(readFileSync(configPath, "utf8")).toBe(before);
		expect(JSON.parse(readFileSync(join(harness.tempDir, "agent", "state.json"), "utf8"))).toEqual({
			modelThinkingLevels: { "faux/first": "high", "faux/second": "low" },
			modelServiceTiers: { "faux/second": "priority" },
		});
	});

	it("never requests settings reload for a real state write and its directory event", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-3178-watch-"));
		agentDirs.push(agentDir);
		const listeners = new Map<string, Set<WatchEventListener>>();
		const notices: string[] = [];
		const reload = vi.fn(async () => {});
		const harness = await createHarness({
			fileSettings: true,
			extensionFactories: [
				(pi) =>
					configReloadExtension(pi, {
						agentDir,
						subscribe: (path, listener) => {
							const entries = listeners.get(path) ?? new Set<WatchEventListener>();
							entries.add(listener);
							listeners.set(path, entries);
							return () => entries.delete(listener);
						},
					}),
			],
		});
		harnesses.push(harness);
		vi.useFakeTimers();
		await harness.session.bindExtensions({
			mode: "tui",
			uiContext: createTestUiContext({ notify: (message) => notices.push(message) }),
			commandContextActions: {
				waitForIdle: async () => {},
				newSession: async () => ({ cancelled: false }),
				fork: async () => ({ cancelled: false }),
				navigateTree: async () => ({ cancelled: false }),
				editAssistantMessage: async () => ({ cancelled: false }),
				editUserMessage: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload,
			},
		});
		expect(listeners.has(agentDir)).toBe(true);
		const settings = SettingsManager.create(harness.tempDir, agentDir);
		settings.setTipShown("example", 123);
		await settings.flush();
		for (const listener of listeners.get(agentDir) ?? []) listener("change", "state.json");
		await vi.advanceTimersByTimeAsync(200);
		expect(reload).not.toHaveBeenCalled();
		expect(notices.filter((message) => message.includes("reload"))).toEqual([]);
	});
});
