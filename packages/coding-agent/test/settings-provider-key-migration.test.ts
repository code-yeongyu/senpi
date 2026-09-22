import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

// Todo 5 (senpi#1989): migrateSettings rewrites every provider-keyed settings
// field from the legacy ids to the canonical subscription ids, in place, on
// first parse. Idempotent; unrecognised shapes are left untouched.
const migrate = (raw: Record<string, unknown>) =>
	(
		SettingsManager as unknown as { migrateSettings(s: Record<string, unknown>): Record<string, unknown> }
	).migrateSettings(structuredClone(raw));

describe("settings provider-key migration (senpi#1989)", () => {
	it("renames the settings block key and defaultProvider", () => {
		const out = migrate({
			defaultProvider: "claude-sdk-oauth",
			claudeSdkOauthProvider: { enabled: true },
		}) as Record<string, unknown>;
		expect(out.defaultProvider).toBe("anthropic-subscription");
		expect("claudeSdkOauthProvider" in out).toBe(false);
		expect(out.anthropicSubscriptionProvider).toEqual({ enabled: true });
	});

	it("rewrites the provider prefix of defaultModel and favoriteModels", () => {
		const out = migrate({
			defaultModel: "openai-codex/gpt-5.6-sol",
			favoriteModels: ["anthropic-subscription/opus", "anthropic/claude"],
		}) as Record<string, unknown>;
		expect(out.defaultModel).toBe("chatgpt-subscription/gpt-5.6-sol");
		expect(out.favoriteModels).toEqual(["anthropic-subscription/opus", "anthropic/claude"]);
	});

	it("rewrites the keys of modelThinkingLevels / modelServiceTiers", () => {
		const out = migrate({
			modelThinkingLevels: { "anthropic-subscription/opus": "high", "anthropic/x": "low" },
			modelServiceTiers: { "openai-codex/gpt-5.6-sol": "priority" },
		}) as Record<string, Record<string, unknown>>;
		expect(out.modelThinkingLevels).toEqual({ "anthropic-subscription/opus": "high", "anthropic/x": "low" });
		expect(out.modelServiceTiers).toEqual({ "chatgpt-subscription/gpt-5.6-sol": "priority" });
	});

	it("rewrites retry.fallbackChains keys and the providers named inside rungs", () => {
		const out = migrate({
			retry: {
				fallbackChains: { "anthropic-subscription/opus": ["anthropic-subscription/opus", "anthropic/claude"] },
			},
		}) as { retry: { fallbackChains: Record<string, string[]> } };
		expect(out.retry.fallbackChains).toEqual({
			"anthropic-subscription/opus": ["anthropic-subscription/opus", "anthropic/claude"],
		});
	});

	it("is idempotent and leaves unrecognised shapes untouched", () => {
		const once = migrate({ defaultProvider: "claude-sdk-oauth", weird: { nested: 1 } });
		const twice = migrate(once as Record<string, unknown>);
		expect(twice).toEqual(once);
		expect((once as Record<string, unknown>).weird).toEqual({ nested: 1 });
	});
});
