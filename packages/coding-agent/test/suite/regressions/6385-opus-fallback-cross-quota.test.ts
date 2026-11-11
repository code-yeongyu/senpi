/**
 * senpi#6385: Anthropic meters Opus on its own quota window. A rate limit on Opus 5.5 is shared by
 * every Opus model on the same account or gateway pool, so the shipped chain must reach a non-Opus
 * model before another Opus rung, or the fallback cannot serve the turn.
 */
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

const isOpus = (selector: string): boolean => /opus/i.test(selector);

describe("the shipped Opus 5.5 chain leaves the Opus quota first (senpi#6385)", () => {
	it("tries a non-Opus Anthropic model before another Opus rung", () => {
		const chain = SettingsManager.inMemory({}).getRetryFallbackSettings().chains["claude-opus-5-5"] ?? [];

		expect(chain[0]).toBe("claude-fable-5-2");
		expect(isOpus(chain[0] ?? "")).toBe(false);
	});

	it("keeps Opus 5 as a later rung for failures that are not quota-related", () => {
		const chain = SettingsManager.inMemory({}).getRetryFallbackSettings().chains["claude-opus-5-5"] ?? [];

		expect(chain).toContain("claude-opus-5");
	});
});
