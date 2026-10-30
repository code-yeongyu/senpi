import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createFallbackCircuitAccess, FallbackCircuitBreaker } from "../../../src/core/retry-fallback/circuit.ts";
import { RetryFallbackController, type RetryFallbackControllerDeps } from "../../../src/core/retry-fallback/controller.ts";
import { SelectorCooldowns } from "../../../src/core/retry-fallback/cooldown.ts";

const MINUTE = 60_000;
const primary = "openai-codex/gpt-5.6-sol";
const fallback = "anthropic/claude-opus-5-5";
// An account-wide usage limit whose reset the provider named itself (senpi#3347).
const usageLimit = {
	errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~120 min.",
	retryAfterMs: 120 * MINUTE,
};

function model(selector: string): Model<Api> {
	const [provider = "", id = ""] = selector.split("/");
	return { ...getModel("anthropic", "claude-opus-4-5"), provider, id };
}

function harness() {
	const models = [model(primary), model(fallback)];
	let now = Date.parse("2026-10-14T10:00:00Z");
	let current: { model: Model<Api> } = { model: models[0] as Model<Api> };
	const logger = { debug: () => {}, info: () => {}, warn: () => {} };
	const deps: RetryFallbackControllerDeps = {
		getSettings: () => ({ modelFallback: true, chains: { [primary]: [fallback] } }),
		registry: {
			find: (provider, id) => models.find((entry) => entry.provider === provider && entry.id === id),
			getAll: () => models,
		},
		cooldowns: new SelectorCooldowns(() => now),
		// The session wires the process-wide breaker with its shipped 30-minute ceiling.
		circuits: createFallbackCircuitAccess({
			breaker: new FallbackCircuitBreaker(),
			owner: () => "session",
			now: () => now,
			settings: () => ({ cooldownMs: MINUTE, maxCooldownMs: 30 * MINUTE }),
			logger,
		}),
		logger,
		switchModel: async (next) => {
			current = { model: next };
		},
		emit: () => {},
		getCurrentSelector: () => current,
		isAuthAvailable: () => true,
	};
	return {
		controller: new RetryFallbackController(deps),
		selector: () => `${current.model.provider}/${current.model.id}`,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("retry fallback: restoring the primary honours its account hold (senpi#3347)", () => {
	it("keeps the fallback while the primary's named usage-limit reset is still ahead", async () => {
		const { controller, selector, advance } = harness();

		await controller.tryFallback("transient", usageLimit);
		expect(selector()).toBe(fallback);
		controller.resetTurn();
		advance(31 * MINUTE);

		expect(await controller.maybeRestorePrimary("cooldown-expiry")).toBe(false);
		expect(selector()).toBe(fallback);
	});

	it("restores the primary once the hold it named has passed", async () => {
		const { controller, selector, advance } = harness();

		await controller.tryFallback("transient", usageLimit);
		controller.resetTurn();
		advance(121 * MINUTE);

		expect(await controller.maybeRestorePrimary("cooldown-expiry")).toBe(true);
		expect(selector()).toBe(primary);
	});
});
