import { describe, expect, it } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.js";

describe("SettingsManager service tier settings", () => {
	it("returns undefined when openai service tier is unset", () => {
		// given
		const manager = SettingsManager.inMemory();

		// when
		const serviceTier = manager.getOpenAIServiceTier();

		// then
		expect(serviceTier).toBeUndefined();
	});

	it("returns the configured openai service tier", () => {
		// given
		const manager = SettingsManager.inMemory({
			openai: {
				serviceTier: "priority",
			},
		});

		// when
		const serviceTier = manager.getOpenAIServiceTier();

		// then
		expect(serviceTier).toBe("priority");
	});
});
