import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const tempDirs: string[] = [];

function createPaths(): { agentDir: string; projectDir: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-retry-fallback-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(join(projectDir, CONFIG_DIR_NAME), { recursive: true });
	return { agentDir, projectDir };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("SettingsManager retry fallback settings", () => {
	it("returns defaults when fallback settings are unset or malformed", () => {
		const { agentDir, projectDir } = createPaths();
		expect(SettingsManager.create(projectDir, agentDir).getRetryFallbackSettings()).toEqual({
			modelFallback: true,
			chains: {},
			revertPolicy: "cooldown-expiry",
		});

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				retry: {
					modelFallback: "enabled",
					fallbackChains: "not a chain map",
					fallbackRevertPolicy: "later",
				},
			}),
		);

		expect(SettingsManager.create(projectDir, agentDir).getRetryFallbackSettings()).toEqual({
			modelFallback: true,
			chains: {},
			revertPolicy: "cooldown-expiry",
		});
	});

	it("persists global fallback settings and a later instance reads them", async () => {
		const { agentDir, projectDir } = createPaths();
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setModelFallbackEnabled(false);
		manager.setFallbackRevertPolicy("never");
		manager.setFallbackChain("anthropic/claude-fable-5", ["ccapi/kimi-k3:max"]);
		await manager.flush();

		const reloaded = SettingsManager.create(projectDir, agentDir);
		expect(reloaded.getRetryFallbackSettings()).toEqual({
			modelFallback: false,
			chains: { "anthropic/claude-fable-5": ["ccapi/kimi-k3:max"] },
			revertPolicy: "never",
		});

		reloaded.removeFallbackChain("missing/model");
		await reloaded.flush();
		expect(existsSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"))).toBe(false);

		reloaded.removeFallbackChain("anthropic/claude-fable-5");
		await reloaded.flush();
		expect(SettingsManager.create(projectDir, agentDir).getRetryFallbackSettings().chains).toEqual({});
	});

	it("uses project retry settings over global settings, replacing chains wholesale", () => {
		const { agentDir, projectDir } = createPaths();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				retry: {
					modelFallback: false,
					fallbackChains: { "anthropic/primary": ["ccapi/global"] },
					fallbackRevertPolicy: "never",
				},
			}),
		);
		const projectSettingsDir = join(projectDir, CONFIG_DIR_NAME);
		writeFileSync(
			join(projectSettingsDir, "settings.json"),
			JSON.stringify({ retry: { fallbackChains: { "anthropic/project": ["ccapi/project"] } } }),
		);

		expect(SettingsManager.create(projectDir, agentDir).getRetryFallbackSettings()).toEqual({
			modelFallback: false,
			chains: { "anthropic/project": ["ccapi/project"] },
			revertPolicy: "never",
		});
		expect(readFileSync(join(projectSettingsDir, "settings.json"), "utf-8")).toContain("anthropic/project");
	});
});
