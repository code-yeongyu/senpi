/**
 * senpi#6385: Anthropic meters Opus on its own quota window. A rate limit on Opus 5.5 is shared by
 * every Opus model on the same account or gateway pool, so the shipped chain must not step onto
 * another Opus rung. Since senpi#6699 (owner's order, Slack ts 1794719397.623049) it has none.
 */
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

const isOpus = (selector: string): boolean => /opus/i.test(selector);

describe("the shipped Opus 5.5 chain leaves the Opus quota (senpi#6385)", () => {
	it("leads with a non-Opus Anthropic model", () => {
		const chain = SettingsManager.inMemory({}).getRetryFallbackSettings().chains["claude-opus-5-5"] ?? [];

		expect(chain[0]).toBe("claude-fable-5-2:medium");
	});

	it("names no Opus rung at all", () => {
		const chain = SettingsManager.inMemory({}).getRetryFallbackSettings().chains["claude-opus-5-5"] ?? [];

		expect(chain.length).toBeGreaterThan(0);
		expect(chain.filter(isOpus)).toEqual([]);
	});
});
