import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as debugLog from "../../../src/core/hidden-stdout-log.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

describe("3178 noncritical state recovery", () => {
	let root: string;
	let agentDir: string;
	let settingsPath: string;
	let statePath: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "senpi-3178-recovery-"));
		agentDir = join(root, "agent");
		mkdirSync(agentDir);
		settingsPath = join(agentDir, "settings.json");
		statePath = join(agentDir, "state.json");
		writeFileSync(settingsPath, '{"theme":"light","defaultModel":"example"}');
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});

	it.each(["truncated", "unreadable"])(
		"loads and saves config despite %s state and logs only once",
		async (failure) => {
			const log = vi.spyOn(debugLog, "appendDebugLogEntry").mockImplementation(() => {});
			if (failure === "truncated") writeFileSync(statePath, "{ truncated");
			else mkdirSync(statePath);
			const manager = SettingsManager.create(root, agentDir);
			SettingsManager.create(root, agentDir);
			expect(manager.getTheme()).toBe("light");
			expect(manager.getDefaultModel()).toBe("example");
			expect(manager.drainErrors()).toEqual([]);
			expect(log).toHaveBeenCalledTimes(1);

			manager.setTheme("dark");
			await manager.flush();
			expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ theme: "dark", defaultModel: "example" });
			expect(manager.drainErrors()).toEqual([]);
			if (failure === "truncated") {
				manager.setTipShown("recovered", 123);
				await manager.flush();
				expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({ tipsHistory: { recovered: 123 } });
				expect(manager.drainErrors()).toEqual([]);
				expect(log).toHaveBeenCalledTimes(1);
			}
		},
	);

	it("keeps bookkeeping re-added by an older build until it is safely migrated", async () => {
		const manager = SettingsManager.create(root, agentDir);
		writeFileSync(settingsPath, '{"theme":"light","tipsHistory":{"older":123}}');

		manager.setTheme("dark");
		await manager.flush();

		const config = JSON.parse(readFileSync(settingsPath, "utf8"));
		const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
		expect(config.tipsHistory ?? state.tipsHistory).toEqual({ older: 123 });
		expect(SettingsManager.create(root, agentDir).getTipsHistory()).toEqual({ older: 123 });
	});

	it("does not resurrect deleted canonical model memory from a legacy provider alias", async () => {
		writeFileSync(
			statePath,
			JSON.stringify({
				modelThinkingLevels: { "openai-codex/example": "low" },
				modelLastOnThinkingLevels: { "openai-codex/example": "low" },
				modelServiceTiers: { "openai-codex/example": "priority" },
			}),
		);
		const manager = SettingsManager.create(root, agentDir);

		manager.setModelThinkingLevel("chatgpt-subscription", "example", undefined);
		manager.setModelServiceTier("chatgpt-subscription", "example", undefined);
		await manager.flush();

		const restarted = SettingsManager.create(root, agentDir);
		expect(restarted.getModelThinkingLevel("chatgpt-subscription", "example")).toBeUndefined();
		expect(restarted.getModelLastOnThinkingLevel("chatgpt-subscription", "example")).toBeUndefined();
		expect(restarted.getModelServiceTier("chatgpt-subscription", "example")).toBeUndefined();
	});

	it("does not retry a failed migration on repeated managers over the same config", () => {
		writeFileSync(settingsPath, '{"theme":"light","tipsHistory":{"legacy":123}}');
		mkdirSync(statePath);
		const log = vi.spyOn(debugLog, "appendDebugLogEntry").mockImplementation(() => {});
		SettingsManager.create(root, agentDir);
		const firstCalls = log.mock.calls.length;
		SettingsManager.create(root, agentDir);
		expect(log.mock.calls).toHaveLength(firstCalls);
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).tipsHistory).toEqual({ legacy: 123 });
	});
});
