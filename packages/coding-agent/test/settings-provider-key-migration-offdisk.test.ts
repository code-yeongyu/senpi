import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

/**
 * Todo 5 (senpi#1989) proved OFF DISK: a real settings.json written with the
 * legacy provider ids is loaded through SettingsManager.create (real file I/O,
 * FileSettingsStorage), and every provider-keyed shape resolves canonical.
 * Calling the private migrateSettings directly cannot prove this path.
 */
const dirs: string[] = [];
function agentDir(): string {
	const d = mkdtempSync(join(tmpdir(), "t5-offdisk-"));
	dirs.push(d);
	return d;
}
function writeGlobal(agent: string, settings: unknown): void {
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "settings.json"), JSON.stringify(settings, null, 2));
}
const LEGACY_SETTINGS = {
	defaultProvider: "claude-sdk-oauth",
	defaultModel: "openai-codex/gpt-5.6-sol",
	favoriteModels: ["anthropic-subscription/opus", "anthropic/claude-opus-4"],
	modelThinkingLevels: { "anthropic-subscription/opus": "high", "anthropic/claude-opus-4": "low" },
	modelServiceTiers: { "openai-codex/gpt-5.6-sol": "priority" },
	modelLastOnThinkingLevels: { "anthropic-subscription/opus": "medium" },
	retry: {
		fallbackChains: { "anthropic-subscription/opus": ["anthropic-subscription/opus", "anthropic/claude-opus-4"] },
	},
	claudeSdkOauthProvider: { tokenInjection: "config-dir" },
	chatgptSubscriptionProvider: { someSetting: true },
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("settings provider-key migration, proved off disk (senpi#1989)", () => {
	it("loads a legacy settings.json from disk and resolves every provider-keyed shape canonical", () => {
		const agent = agentDir();
		const cwd = agentDir();
		writeGlobal(agent, LEGACY_SETTINGS);

		const manager = SettingsManager.create(cwd, agent);
		const s = manager.getGlobalSettings() as Record<string, unknown>;

		// 1. scalar provider + 2. model ref prefix
		expect(s.defaultProvider).toBe("anthropic-subscription");
		expect(s.defaultModel).toBe("chatgpt-subscription/gpt-5.6-sol");
		// 3. favourites (array of model refs), untouched API-key provider preserved
		expect(s.favoriteModels).toEqual(["anthropic-subscription/opus", "anthropic/claude-opus-4"]);
		// 4/5/6. the three `${provider}/${id}`-keyed maps
		expect(s.modelThinkingLevels).toEqual({
			"anthropic-subscription/opus": "high",
			"anthropic/claude-opus-4": "low",
		});
		expect(s.modelServiceTiers).toEqual({ "chatgpt-subscription/gpt-5.6-sol": "priority" });
		expect(s.modelLastOnThinkingLevels).toEqual({ "anthropic-subscription/opus": "medium" });
		// 7. fallback chains: keys AND the providers named inside each rung
		expect((s.retry as { fallbackChains: unknown }).fallbackChains).toEqual({
			"anthropic-subscription/opus": ["anthropic-subscription/opus", "anthropic/claude-opus-4"],
		});
		// the settings blocks themselves
		expect(s.anthropicSubscriptionProvider).toEqual({ tokenInjection: "config-dir" });
		expect(s.chatgptSubscriptionProvider).toEqual({ someSetting: true });
		// Both LEGACY settings-block keys must be gone after migration. These are
		// legacy KEY STRINGS, not symbols — a symbol sweep must not rewrite them,
		// or this contradicts the two assertions above.
		expect("claudeSdkOauthProvider" in s).toBe(false);
		expect("openaiCodexProvider" in s).toBe(false);
	});

	it("leaves an already-canonical settings.json byte-identical in meaning (idempotent off disk)", () => {
		const agent = agentDir();
		const cwd = agentDir();
		const canonical = {
			defaultProvider: "anthropic-subscription",
			defaultModel: "chatgpt-subscription/gpt-5.6-sol",
			modelThinkingLevels: { "anthropic-subscription/opus": "high" },
		};
		writeGlobal(agent, canonical);
		const s = SettingsManager.create(cwd, agent).getGlobalSettings() as Record<string, unknown>;
		expect(s.defaultProvider).toBe("anthropic-subscription");
		expect(s.defaultModel).toBe("chatgpt-subscription/gpt-5.6-sol");
		expect(s.modelThinkingLevels).toEqual({ "anthropic-subscription/opus": "high" });
	});

	it("does not hard-error on an unrecognised shape and leaves it untouched", () => {
		const agent = agentDir();
		const cwd = agentDir();
		writeGlobal(agent, {
			defaultProvider: "claude-sdk-oauth",
			weird: { nested: [1, 2] },
			modelThinkingLevels: "not-an-object",
		});
		const s = SettingsManager.create(cwd, agent).getGlobalSettings() as Record<string, unknown>;
		expect(s.defaultProvider).toBe("anthropic-subscription");
		expect(s.weird).toEqual({ nested: [1, 2] });
		expect(s.modelThinkingLevels).toBe("not-an-object");
	});
});
