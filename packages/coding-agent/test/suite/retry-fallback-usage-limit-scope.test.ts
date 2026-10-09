import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { RetryFallbackController, type RetryFallbackControllerDeps } from "../../src/core/retry-fallback/controller.ts";
import { SelectorCooldowns } from "../../src/core/retry-fallback/cooldown.ts";

function model(provider: string, id: string): Model<Api> {
	return { ...getModel("anthropic", "claude-opus-4-5"), provider, id };
}

const fable = model("anthropic-subscription", "claude-fable-5-1");
const opus = model("anthropic-subscription", "claude-opus-5-5");
const kimi = model("kimi-coding", "kimi-k3");
const models = [fable, opus, kimi];

function createController(chain: readonly string[]) {
	let current: { model: Model<Api> } = { model: fable };
	const events: unknown[] = [];
	const deps: RetryFallbackControllerDeps = {
		getSettings: () => ({ modelFallback: true, chains: { "anthropic-subscription/claude-fable-5-1": chain } }),
		registry: {
			find: (provider, id) => models.find((entry) => entry.provider === provider && entry.id === id),
			getAll: () => models,
		},
		cooldowns: new SelectorCooldowns(() => 0),
		logger: { debug: () => {}, info: () => {}, warn: () => {} },
		switchModel: async (next) => {
			current = { model: next };
		},
		emit: (event) => events.push(event),
		getCurrentSelector: () => current,
		isAuthAvailable: () => true,
	};
	return { controller: new RetryFallbackController(deps), events, current: () => current.model };
}

const fullChain = ["anthropic-subscription/claude-opus-5-5", "kimi-coding/kimi-k3"];

describe("retry fallback usage-limit scope", () => {
	it("#given an account-wide Claude session limit #when falling back #then it skips the other models on that exhausted provider", async () => {
		const { controller, events, current } = createController(fullChain);

		const switched = await controller.tryFallback("hard-error", {
			errorMessage: "You've hit your session limit · resets 3pm (Asia/Seoul)",
		});

		expect({ switched, model: `${current().provider}/${current().id}`, events }).toEqual({
			switched: true,
			model: "kimi-coding/kimi-k3",
			events: [
				expect.objectContaining({
					type: "retry_fallback_applied",
					from: "anthropic-subscription/claude-fable-5-1",
					to: "kimi-coding/kimi-k3",
					limit: "account",
				}),
			],
		});
	});

	it("#given a limit scoped to one model #when falling back #then the next model on the same provider serves the turn", async () => {
		const { controller, events, current } = createController(fullChain);

		const switched = await controller.tryFallback("hard-error", {
			errorMessage: "You've hit your Fable weekly limit · resets Oct 2, 9am",
		});

		expect({ switched, model: `${current().provider}/${current().id}`, events }).toEqual({
			switched: true,
			model: "anthropic-subscription/claude-opus-5-5",
			events: [expect.objectContaining({ to: "anthropic-subscription/claude-opus-5-5", limit: "model" })],
		});
	});

	it("#given Claude Code's model-limit text (senpi#2555) #when falling back #then only Fable moves to its next rung and the account stays usable for Opus", async () => {
		const { controller, events, current } = createController(fullChain);

		const switched = await controller.tryFallback("hard-error", {
			errorMessage: "You've reached your Fable limit. Switch to another model to continue. (rate_limit)",
		});

		expect({ switched, model: `${current().provider}/${current().id}`, events }).toEqual({
			switched: true,
			model: "anthropic-subscription/claude-opus-5-5",
			events: [expect.objectContaining({ to: "anthropic-subscription/claude-opus-5-5", limit: "model" })],
		});
	});

	it("#given an account-wide limit and only same-provider rungs left #when falling back #then the remaining rung is still tried as the last resort", async () => {
		const { controller, events } = createController(["anthropic-subscription/claude-opus-5-5"]);

		const switched = await controller.tryFallback("transient", {
			errorMessage: '429 {"type":"usage_limit_reached","message":"The usage limit has been reached"}',
		});

		expect({ switched, events }).toEqual({
			switched: true,
			events: [expect.objectContaining({ to: "anthropic-subscription/claude-opus-5-5", limit: "account" })],
		});
	});

	it("#given an account-wide limit #when the other provider's rung is spent too #then the chain falls back to the same-provider rung before exhausting", async () => {
		const { controller, current } = createController([
			"kimi-coding/kimi-k3",
			"anthropic-subscription/claude-opus-5-5",
		]);
		const limit = { errorMessage: "You've hit your session limit · resets 3pm (Asia/Seoul)" };

		const hops = [await controller.tryFallback("hard-error", limit)];
		const afterFirst = `${current().provider}/${current().id}`;
		hops.push(await controller.tryFallback("hard-error", { errorMessage: "HTTP 500: internal_error" }));
		const afterSecond = `${current().provider}/${current().id}`;
		hops.push(await controller.tryFallback("hard-error", limit));

		expect({ hops, afterFirst, afterSecond, exhausted: controller.exhaustedChainKey }).toEqual({
			hops: [true, true, false],
			afterFirst: "kimi-coding/kimi-k3",
			afterSecond: "anthropic-subscription/claude-opus-5-5",
			exhausted: "anthropic-subscription/claude-fable-5-1",
		});
	});

	it("#given a transient rate limit #when falling back #then same-provider rungs stay eligible and no limit is reported", async () => {
		const { controller, events } = createController(fullChain);

		await controller.tryFallback("transient", { errorMessage: "HTTP 429: rate_limit_error" });

		expect(events.map((event) => [Reflect.get(Object(event), "to"), Object.hasOwn(Object(event), "limit")])).toEqual([
			["anthropic-subscription/claude-opus-5-5", false],
		]);
	});
});
