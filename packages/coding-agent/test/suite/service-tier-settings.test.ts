import { describe, expect, it } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.ts";

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

	it("enables OpenAI Codex fast mode by default", () => {
		expect(SettingsManager.inMemory().getOpenAIDefaultFastMode()).toBe(true);
	});

	it("persists an explicit OpenAI Codex fast mode preference", () => {
		const manager = SettingsManager.inMemory();

		manager.setOpenAIDefaultFastMode(false);

		expect(manager.getOpenAIDefaultFastMode()).toBe(false);
	});
});
