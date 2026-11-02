import type { Api, Model } from "@earendil-works/pi-ai";
import { MAX_SLOT_BLOCK_MS } from "@earendil-works/pi-ai/auth/pool/failover";
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

function createController(chain: readonly string[], now: () => number = () => 0, wallNow: () => number = now) {
	let current: { model: Model<Api> } = { model: fable };
	const events: unknown[] = [];
	const deps: RetryFallbackControllerDeps = {
		getSettings: () => ({ modelFallback: true, chains: { "anthropic-subscription/claude-fable-5-1": chain } }),
		registry: {
			find: (provider, id) => models.find((entry) => entry.provider === provider && entry.id === id),
			getAll: () => models,
		},
		cooldowns: new SelectorCooldowns(now, undefined, wallNow),
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

	it("#given an account-wide limit and only same-provider rungs left #when falling back #then no spent account is tried", async () => {
		const { controller, events } = createController(["anthropic-subscription/claude-opus-5-5"]);

		const switched = await controller.tryFallback("transient", {
			errorMessage: '429 {"type":"usage_limit_reached","message":"The usage limit has been reached"}',
		});

		expect({ switched, events }).toEqual({
			switched: false,
			events: [],
		});
	});

	it("#given an account-wide limit #when the other provider's rung fails too #then the spent provider stays excluded", async () => {
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
			hops: [true, false, false],
			afterFirst: "kimi-coding/kimi-k3",
			afterSecond: "kimi-coding/kimi-k3",
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

	it("clears the spent account for a deliberate manual model probe", async () => {
		// given
		const { controller } = createController(fullChain);
		await controller.tryFallback("transient", { errorMessage: "You've hit your session limit" });
		// when
		controller.clearForManualModelChange(opus);
		// then
		expect(controller.isProviderSpent(opus.provider)).toBe(false);
	});

	it("does not shorten or renew a remembered retry-after deadline when routing local refusals", async () => {
		let now = 0;
		const { controller } = createController(["anthropic-subscription/claude-opus-5-5"], () => now);
		const failure = {
			errorMessage: '429 {"type":"usage_limit_reached","message":"The usage limit has been reached"}',
			retryAfterMs: 90_000,
		};
		controller.noteHealthFailure(fable, undefined, failure);
		for (const elapsed of [30_000, 60_000, 89_999]) {
			now = elapsed;
			expect(await controller.tryFallback("transient", failure, false)).toBe(false);
		}
		now = 90_001;
		expect(controller.isProviderSpent(fable.provider)).toBe(false);
	});

	it("caps an oversized provider retry-after hint", () => {
		let now = 0;
		const { controller } = createController(fullChain, () => now);
		controller.noteHealthFailure(fable, undefined, {
			errorMessage: "usage_limit_reached: the usage limit has been reached",
			retryAfterMs: Number.MAX_SAFE_INTEGER,
		});
		expect(controller.isProviderSpent(fable.provider)).toBe(true);
		now = MAX_SLOT_BLOCK_MS + 1;
		expect(controller.isProviderSpent(fable.provider)).toBe(false);
	});

	it("does not forget a fresh account failure for zero or expired hints", () => {
		const epoch = Date.UTC(2026, 9, 11);
		const { controller } = createController(
			fullChain,
			() => 0,
			() => epoch,
		);
		controller.noteHealthFailure(fable, undefined, {
			errorMessage: JSON.stringify({
				error: {
					type: "usage_limit_reached",
					message: "The usage limit has been reached",
					resets_at: epoch / 1000 - 1,
				},
			}),
			retryAfterMs: 0,
		});
		expect(controller.isProviderSpent(fable.provider)).toBe(true);
	});

	it("honors a later account reset even when retry-after is shorter", () => {
		const epoch = Date.UTC(2026, 9, 11);
		let now = 0;
		const { controller } = createController(
			fullChain,
			() => now,
			() => epoch + now,
		);
		controller.noteHealthFailure(fable, undefined, {
			errorMessage: JSON.stringify({
				error: {
					type: "usage_limit_reached",
					message: "The usage limit has been reached",
					resets_at: epoch / 1000 + 60,
				},
			}),
			retryAfterMs: 30_000,
		});
		now = 31_000;
		expect(controller.isProviderSpent(fable.provider)).toBe(true);
		now = 60_001;
		expect(controller.isProviderSpent(fable.provider)).toBe(false);
	});
});
