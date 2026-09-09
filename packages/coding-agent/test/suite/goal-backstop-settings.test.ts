import { describe, expect, it } from "vitest";
import { GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS } from "../../src/core/extensions/builtin/goal/cache-warm.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("promptCache.goalBackstopMaxSeconds resolution", () => {
	it("defaults to the goal monitor's 270s re-check when unset", () => {
		const manager = SettingsManager.inMemory();
		expect(manager.getPromptCacheGoalBackstopMaxSeconds()).toBe(270);
	});

	it("carries the same default as the goal extension's constant", () => {
		// settings-manager resolves the setting and the goal extension falls back to
		// the constant when no setting reaches it; a drift between the two would arm
		// one delay and document another.
		expect(SettingsManager.inMemory().getPromptCacheGoalBackstopMaxSeconds() * 1000).toBe(
			GOAL_MONITOR_BACKSTOP_DEFAULT_DELAY_MS,
		);
	});

	it("honors a configured ceiling such as the opt-in long backstop", () => {
		const manager = SettingsManager.inMemory({ promptCache: { goalBackstopMaxSeconds: 3570 } });
		expect(manager.getPromptCacheGoalBackstopMaxSeconds()).toBe(3570);
	});
});
