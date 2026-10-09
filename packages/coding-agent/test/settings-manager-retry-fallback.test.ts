import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import {
	DEFAULT_HINTED_WAIT_CAP_MS,
	DEFAULT_PROBE_BACK_MAX_MS,
	resolveHintPolicySettings,
} from "../src/core/retry-fallback/settings.ts";
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

describe("SettingsManager runtime overrides (--no-model-fallback, omo#8700)", () => {
	it("keeps an override after a save of an unrelated setting", () => {
		const { agentDir, projectDir } = createPaths();
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.applyOverrides({ retry: { modelFallback: false } });

		manager.setDefaultThinkingLevel("high");

		expect(manager.getRetryFallbackSettings().modelFallback).toBe(false);
	});

	it("keeps an override across reload()", async () => {
		const { agentDir, projectDir } = createPaths();
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.applyOverrides({ retry: { modelFallback: false }, askUser: { enabled: false } });

		await manager.reload();

		expect(manager.getRetryFallbackSettings().modelFallback).toBe(false);
		expect(manager.getAskUserSettings().enabled).toBe(false);
	});

	it("lets an explicit in-session setter win for exactly the key it sets", () => {
		const { agentDir, projectDir } = createPaths();
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.applyOverrides({ retry: { modelFallback: false }, askUser: { enabled: false } });

		manager.setModelFallbackEnabled(true);

		expect(manager.getRetryFallbackSettings().modelFallback).toBe(true);
		expect(manager.getAskUserSettings().enabled).toBe(false);
	});

	it("never writes an override to the settings file", async () => {
		const { agentDir, projectDir } = createPaths();
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.applyOverrides({ retry: { modelFallback: false } });

		manager.setDefaultThinkingLevel("high");
		await manager.flush();

		const written = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
			retry?: { modelFallback?: boolean };
		};
		expect(written.retry?.modelFallback).toBeUndefined();
	});
});

describe("SettingsManager retry fallback settings", () => {
	// Fallback chains ship EMPTY by default (2026-09-05 "require explicit fallback
	// chains"): no implicit lanes, no wildcard escape route — a model falls back only
	// when the user configured a chain for it.

	it("defaults abortServerSideFallback to true and round-trips an explicit false", () => {
		const { agentDir, projectDir } = createPaths();
		expect(SettingsManager.create(projectDir, agentDir).getAbortServerSideFallback()).toBe(true);

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { abortServerSideFallback: false } }));
		expect(SettingsManager.create(projectDir, agentDir).getAbortServerSideFallback()).toBe(false);

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { abortServerSideFallback: "no" } }));
		expect(SettingsManager.create(projectDir, agentDir).getAbortServerSideFallback()).toBe(true);
	});

	it("returns the shipped chains when fallback settings are unset or malformed", () => {
		const { agentDir, projectDir } = createPaths();
		const shipped = {
			"claude-fable-5": ["claude-opus-5-5:max", "claude-opus-5:max", "claude-opus-4-8:max", "claude-opus-4-6:max"],
			"claude-fable-5-1": ["claude-opus-5-5:max", "claude-opus-5:max", "claude-opus-4-8:max", "claude-opus-4-6:max"],
			"claude-opus-5-5": ["claude-opus-5:max", "claude-opus-4-8:max", "claude-opus-4-6:max"],
		};
		expect(SettingsManager.create(projectDir, agentDir).getRetryFallbackSettings()).toEqual({
			modelFallback: true,
			chains: shipped,
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
			chains: shipped,
			revertPolicy: "cooldown-expiry",
		});
	});

	it("persists global fallback settings and a later instance reads them", async () => {
		const { agentDir, projectDir } = createPaths();
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setModelFallbackEnabled(false);
		manager.setFallbackRevertPolicy("never");
		manager.setFallbackChain("claude-fable-5", ["ccapi/kimi-k3:max"]);
		await manager.flush();

		const reloaded = SettingsManager.create(projectDir, agentDir);
		// The configured key replaces its shipped default outright; the other shipped key stays.
		expect(reloaded.getRetryFallbackSettings()).toEqual({
			modelFallback: false,
			chains: {
				"claude-fable-5": ["ccapi/kimi-k3:max"],
				"claude-fable-5-1": [
					"claude-opus-5-5:max",
					"claude-opus-5:max",
					"claude-opus-4-8:max",
					"claude-opus-4-6:max",
				],
				"claude-opus-5-5": ["claude-opus-5:max", "claude-opus-4-8:max", "claude-opus-4-6:max"],
			},
			revertPolicy: "never",
		});

		reloaded.removeFallbackChain("missing/model");
		await reloaded.flush();
		expect(existsSync(join(projectDir, CONFIG_DIR_NAME, "settings.json"))).toBe(false);

		// Removing the user's override restores the shipped default for that family.
		reloaded.removeFallbackChain("claude-fable-5");
		await reloaded.flush();
		expect(SettingsManager.create(projectDir, agentDir).getRetryFallbackSettings().chains).toEqual({
			"claude-fable-5": ["claude-opus-5-5:max", "claude-opus-5:max", "claude-opus-4-8:max", "claude-opus-4-6:max"],
			"claude-fable-5-1": ["claude-opus-5-5:max", "claude-opus-5:max", "claude-opus-4-8:max", "claude-opus-4-6:max"],
			"claude-opus-5-5": ["claude-opus-5:max", "claude-opus-4-8:max", "claude-opus-4-6:max"],
		});
	});

	it("reports which settings scope supplied the fallback chains", () => {
		const { agentDir, projectDir } = createPaths();
		// Nothing configured: the resolved chains are the shipped defaults, not a file.
		expect(SettingsManager.create(projectDir, agentDir).getFallbackChainsScope()).toBeUndefined();

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ retry: { fallbackChains: { "claude-fable-5": ["ccapi/kimi-k3:max"] } } }),
		);
		expect(SettingsManager.create(projectDir, agentDir).getFallbackChainsScope()).toBe("global");

		writeFileSync(
			join(projectDir, CONFIG_DIR_NAME, "settings.json"),
			JSON.stringify({ retry: { fallbackChains: { "anthropic/project": ["ccapi/project"] } } }),
		);
		expect(SettingsManager.create(projectDir, agentDir).getFallbackChainsScope()).toBe("project");
	});

	it("names a malformed chain map's offending type so one log line identifies it", () => {
		const { agentDir, projectDir } = createPaths();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { fallbackChains: null } }));
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getFallbackChainsScope()).toBe("global");
		// Malformed input degrades to the shipped defaults, never to a half-read map.
		expect(manager.getRetryFallbackSettings().chains).toEqual({
			"claude-fable-5": ["claude-opus-5-5:max", "claude-opus-5:max", "claude-opus-4-8:max", "claude-opus-4-6:max"],
			"claude-fable-5-1": ["claude-opus-5-5:max", "claude-opus-5:max", "claude-opus-4-8:max", "claude-opus-4-6:max"],
			"claude-opus-5-5": ["claude-opus-5:max", "claude-opus-4-8:max", "claude-opus-4-6:max"],
		});
	});

	it("resolves only the chains the user configured", () => {
		const { agentDir, projectDir } = createPaths();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				retry: {
					fallbackChains: {
						"example-gateway/unrelated-model": ["example-gateway/unrelated-fallback:max"],
					},
				},
			}),
		);

		const chains = SettingsManager.create(projectDir, agentDir).getRetryFallbackSettings().chains;

		expect(chains["example-gateway/unrelated-model"]).toEqual(["example-gateway/unrelated-fallback:max"]);
		// An unrelated key layers over the shipped defaults instead of replacing the map.
		expect(chains["claude-fable-5"]).toEqual([
			"claude-opus-5-5:max",
			"claude-opus-5:max",
			"claude-opus-4-8:max",
			"claude-opus-4-6:max",
		]);
		expect(Object.keys(chains).sort()).toEqual([
			"claude-fable-5",
			"claude-fable-5-1",
			"claude-opus-5-5",
			"example-gateway/unrelated-model",
		]);
	});

	it("lets a user chain replace a default outright and an empty array delete it", () => {
		const { agentDir, projectDir } = createPaths();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				retry: { fallbackChains: { "claude-fable-5": ["ccapi/kimi-k3:max"] } },
			}),
		);
		expect(SettingsManager.create(projectDir, agentDir).getRetryFallbackSettings().chains["claude-fable-5"]).toEqual([
			"ccapi/kimi-k3:max",
		]);

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ retry: { fallbackChains: { "claude-fable-5": [] } } }),
		);
		// Tombstone: the empty list is preserved through resolution and consumed by
		// canonicalization, which drops every expanded provider variant of the family.
		expect(SettingsManager.create(projectDir, agentDir).getRetryFallbackSettings().chains["claude-fable-5"]).toEqual(
			[],
		);
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

		const resolved = SettingsManager.create(projectDir, agentDir).getRetryFallbackSettings();
		expect(resolved.modelFallback).toBe(false);
		expect(resolved.revertPolicy).toBe("never");
		// Project scope replaces the global scope's chain map wholesale: the global
		// "anthropic/primary" entry must not survive into the project-scoped result.
		expect(resolved.chains["anthropic/project"]).toEqual(["ccapi/project"]);
		expect(resolved.chains).not.toHaveProperty("anthropic/primary");
		expect(readFileSync(join(projectSettingsDir, "settings.json"), "utf-8")).toContain("anthropic/project");
	});

	it("getHintPolicySettings returns defaults when unset", () => {
		const { agentDir, projectDir } = createPaths();
		expect(SettingsManager.create(projectDir, agentDir).getHintPolicySettings()).toEqual({
			hintedWaitCapMs: DEFAULT_HINTED_WAIT_CAP_MS,
			probeBackMaxMs: DEFAULT_PROBE_BACK_MAX_MS,
		});
	});

	it("getHintPolicySettings returns overridden values when valid", () => {
		const { agentDir, projectDir } = createPaths();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ retry: { hintedWaitCapMs: 120_000, probeBackMaxMs: 7_200_000 } }),
		);
		expect(SettingsManager.create(projectDir, agentDir).getHintPolicySettings()).toEqual({
			hintedWaitCapMs: 120_000,
			probeBackMaxMs: 7_200_000,
		});
	});

	it("file round-trip falls back to defaults for malformed (string/negative); resolver guard rejects NaN directly", () => {
		// JSON.stringify(NaN) -> null, so the file round-trip cannot exercise the
		// NaN guard in resolveHintPolicySettings. Test it directly:
		expect(resolveHintPolicySettings({ hintedWaitCapMs: Number.NaN, probeBackMaxMs: Number.NaN })).toEqual({
			hintedWaitCapMs: DEFAULT_HINTED_WAIT_CAP_MS,
			probeBackMaxMs: DEFAULT_PROBE_BACK_MAX_MS,
		});

		const { agentDir, projectDir } = createPaths();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				retry: { hintedWaitCapMs: "large", probeBackMaxMs: Number.NaN },
			}),
		);
		expect(SettingsManager.create(projectDir, agentDir).getHintPolicySettings()).toEqual({
			hintedWaitCapMs: DEFAULT_HINTED_WAIT_CAP_MS,
			probeBackMaxMs: DEFAULT_PROBE_BACK_MAX_MS,
		});

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				retry: { hintedWaitCapMs: -5, probeBackMaxMs: -1 },
			}),
		);
		expect(SettingsManager.create(projectDir, agentDir).getHintPolicySettings()).toEqual({
			hintedWaitCapMs: DEFAULT_HINTED_WAIT_CAP_MS,
			probeBackMaxMs: DEFAULT_PROBE_BACK_MAX_MS,
		});
	});

	it("getHintPolicySettings resets BOTH to defaults when probeBackMaxMs <= hintedWaitCapMs", () => {
		const { agentDir, projectDir } = createPaths();
		// equal values: probeBackMaxMs === hintedWaitCapMs -> both default
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ retry: { hintedWaitCapMs: 500_000, probeBackMaxMs: 500_000 } }),
		);
		expect(SettingsManager.create(projectDir, agentDir).getHintPolicySettings()).toEqual({
			hintedWaitCapMs: DEFAULT_HINTED_WAIT_CAP_MS,
			probeBackMaxMs: DEFAULT_PROBE_BACK_MAX_MS,
		});

		// probeBackMaxMs strictly less than hintedWaitCapMs -> both default
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ retry: { hintedWaitCapMs: 600_000, probeBackMaxMs: 300_000 } }),
		);
		expect(SettingsManager.create(projectDir, agentDir).getHintPolicySettings()).toEqual({
			hintedWaitCapMs: DEFAULT_HINTED_WAIT_CAP_MS,
			probeBackMaxMs: DEFAULT_PROBE_BACK_MAX_MS,
		});
	});
});
