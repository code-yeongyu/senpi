/**
 * senpi#4673: a fallback policy a session's opener supplies (`open_session.retryFallback`,
 * `set_retry_fallback`) is that session's whole policy; the shipped default chains are not merged back
 * under it. A session without one still layers its settings over the defaults.
 */
import { describe, expect, it } from "vitest";
import { applyRetryFallbackProfile } from "../../../src/core/agent-session-runtime.ts";
import { DEFAULT_FALLBACK_CHAINS } from "../../../src/core/retry-fallback/settings.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

const SESSION_POLICY = { modelFallback: true, fallbackChains: { "p/x": ["q/y"] } } as const;

describe("a per-session fallback policy replaces the shipped defaults (senpi#4673)", () => {
	it("keeps only the chains the opener supplied", () => {
		const settings = SettingsManager.inMemory({
			defaultProvider: "anthropic-subscription",
			defaultModel: "claude-opus-5-5",
		});

		applyRetryFallbackProfile(settings, SESSION_POLICY);

		const resolved = settings.getRetryFallbackSettings();
		expect(resolved.chains["claude-opus-5-5"]).toBeUndefined();
		expect(resolved.chains).toEqual({ "p/x": ["q/y"] });
		expect(resolved.modelFallback).toBe(true);
	});

	it("still layers a session's own settings chains over the defaults", () => {
		const settings = SettingsManager.inMemory({ retry: { fallbackChains: { "p/x": ["q/y"] } } });

		const resolved = settings.getRetryFallbackSettings();
		expect(resolved.chains["claude-opus-5-5"]).toEqual(DEFAULT_FALLBACK_CHAINS["claude-opus-5-5"]);
		expect(resolved.chains["p/x"]).toEqual(["q/y"]);
	});
});
