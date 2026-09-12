import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { RetryFallbackController, type RetryFallbackControllerDeps } from "../../src/core/retry-fallback/controller.ts";
import { SelectorCooldowns } from "../../src/core/retry-fallback/cooldown.ts";
import { getSupportedThinkingLevels } from "../../src/core/thinking-levels.ts";

/**
 * Primary is a fully graded reasoning model; the fallback fixtures below vary only in
 * `thinkingLevelMap` so the clamp behaviour is exercised against real catalog shapes.
 */
const primary: Model<Api> = { ...getModel("openai", "gpt-5.4"), provider: "faux", id: "primary" };

/** Always-on: "off" is vetoed, so a requested "off" has to clamp to the nearest supported level. */
const alwaysOn: Model<Api> = {
	...getModel("openai", "gpt-5.4"),
	provider: "faux",
	id: "always-on",
	thinkingLevelMap: { off: null },
};

/** Off/high toggle model: supports only "off" and "high". */
const toggle: Model<Api> = {
	...getModel("openai", "gpt-5.4"),
	provider: "faux",
	id: "toggle",
	thinkingLevelMap: { minimal: null, low: null, medium: null, xhigh: null, max: null },
};

const nonReasoning: Model<Api> = {
	...getModel("openai", "gpt-5.4"),
	provider: "faux",
	id: "non-reasoning",
	reasoning: false,
};

interface SwitchRecord {
	provider: string;
	id: string;
	thinking: ThinkingLevel;
	reason: "fallback" | "fallback-revert";
}

function createController(options: {
	models: Model<Api>[];
	chains: Record<string, readonly string[]>;
	current: { model: Model<Api>; thinkingLevel?: ThinkingLevel };
}): { controller: RetryFallbackController; switches: SwitchRecord[] } {
	const switches: SwitchRecord[] = [];
	let current = options.current;
	const deps: RetryFallbackControllerDeps = {
		getSettings: () => ({ modelFallback: true, chains: options.chains }),
		registry: {
			find: (provider, id) => options.models.find((model) => model.provider === provider && model.id === id),
			getAll: () => options.models,
		},
		cooldowns: new SelectorCooldowns(() => 0),
		logger: { debug: () => {}, info: () => {}, warn: () => {} },
		switchModel: async (model, thinking, reason) => {
			switches.push({ provider: model.provider, id: model.id, thinking, reason });
			current = { model, thinkingLevel: thinking };
		},
		emit: () => {},
		getCurrentSelector: () => current,
		isAuthAvailable: () => true,
	};
	return { controller: new RetryFallbackController(deps), switches };
}

describe("retry fallback thinking-level selection", () => {
	it("keeps a requested level that the fallback model supports", async () => {
		const { controller, switches } = createController({
			models: [primary, toggle],
			chains: { "faux/primary": ["faux/toggle"] },
			current: { model: primary, thinkingLevel: "high" },
		});

		expect(await controller.tryFallback("transient", {})).toBe(true);
		expect(switches).toEqual([{ provider: "faux", id: "toggle", thinking: "high", reason: "fallback" }]);
	});

	it("honours an explicit selector thinking level over the inherited level", async () => {
		const { controller, switches } = createController({
			models: [primary, toggle],
			chains: { "faux/primary": ["faux/toggle:off"] },
			current: { model: primary, thinkingLevel: "high" },
		});

		expect(await controller.tryFallback("transient", {})).toBe(true);
		expect(switches[0]?.thinking).toBe("off");
	});

	it("clamps to 'off' when falling back to a non-reasoning model", async () => {
		const { controller, switches } = createController({
			models: [primary, nonReasoning],
			chains: { "faux/primary": ["faux/non-reasoning"] },
			current: { model: primary, thinkingLevel: "high" },
		});

		expect(await controller.tryFallback("transient", {})).toBe(true);
		expect(switches[0]?.thinking).toBe("off");
	});

	it("clamps a requested 'off' to the lowest supported level on an always-on model", async () => {
		const supported = getSupportedThinkingLevels(alwaysOn);
		expect(supported).not.toContain("off");
		const { controller, switches } = createController({
			models: [primary, alwaysOn],
			chains: { "faux/primary": ["faux/always-on"] },
			current: { model: primary, thinkingLevel: "off" },
		});

		expect(await controller.tryFallback("transient", {})).toBe(true);
		// Canonical clamp walks to the NEAREST supported level, never escalating to max.
		expect(switches[0]?.thinking).toBe(supported[0]);
		expect(switches[0]?.thinking).not.toBe(supported[supported.length - 1]);
	});

	it("clamps a mid-ladder request down to the nearest supported level on a toggle model", async () => {
		const { controller, switches } = createController({
			models: [primary, toggle],
			chains: { "faux/primary": ["faux/toggle"] },
			current: { model: primary, thinkingLevel: "low" },
		});

		expect(await controller.tryFallback("transient", {})).toBe(true);
		// Supported = [off, high]; "low" clamps upward to the nearest supported level.
		expect(getSupportedThinkingLevels(toggle)).toEqual(["off", "high"]);
		expect(switches[0]?.thinking).toBe("high");
	});

	it("clamps 'max' down to the highest supported level rather than failing", async () => {
		const { controller, switches } = createController({
			models: [primary, toggle],
			chains: { "faux/primary": ["faux/toggle"] },
			current: { model: primary, thinkingLevel: "max" },
		});

		expect(await controller.tryFallback("transient", {})).toBe(true);
		expect(switches[0]?.thinking).toBe("high");
	});

	it("clamps a requested 'off' on an always-on model reached through a repeated fallback window", async () => {
		const { controller, switches } = createController({
			models: [primary, toggle, alwaysOn],
			chains: { "faux/primary": ["faux/toggle:off", "faux/always-on"] },
			current: { model: primary, thinkingLevel: "off" },
		});

		expect(await controller.tryFallback("transient", {})).toBe(true);
		expect(await controller.tryFallback("transient", {})).toBe(true);
		expect(switches.map((record) => `${record.id}:${record.thinking}`)).toEqual([
			"toggle:off",
			`always-on:${getSupportedThinkingLevels(alwaysOn)[0]}`,
		]);
		// The fallback window still remembers the pre-fallback level for the revert.
		expect(controller.activeState?.originalThinkingLevel).toBe("off");
	});
});
