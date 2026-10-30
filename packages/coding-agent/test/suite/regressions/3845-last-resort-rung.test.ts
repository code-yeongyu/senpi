import type { Api, Model } from "@earendil-works/pi-ai";
import { PROVIDER_NOT_CONFIGURED_PREFIX } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	RetryFallbackController,
	type RetryFallbackControllerDeps,
} from "../../../src/core/retry-fallback/controller.ts";
import { SelectorCooldowns } from "../../../src/core/retry-fallback/cooldown.ts";
import { validateFallbackChains } from "../../../src/core/retry-fallback/validate.ts";

function model(provider: string, id: string): Model<Api> {
	return { ...getModel("anthropic", "claude-opus-4-5"), provider, id };
}

const primary = model("anthropic-subscription", "claude-fable-5-1");
const sibling = model("anthropic-subscription", "claude-opus-5-5");
const second = model("kimi-coding", "kimi-k3");
const parent = model("openai-codex", "gpt-6-sol");
const models = [primary, sibling, second, parent];
const registry = {
	find: (provider: string, id: string) => models.find((entry) => entry.provider === provider && entry.id === id),
	getAll: () => models,
};

const ACCOUNT_LIMIT = "You've hit your session limit · resets 3pm (Asia/Seoul)";
const USAGE_LIMIT_JSON = '429 {"type":"usage_limit_reached","message":"The usage limit has been reached"}';

function createController(chain: readonly string[]) {
	let current: { model: Model<Api> } = { model: primary };
	const switches: string[] = [];
	const deps: RetryFallbackControllerDeps = {
		getSettings: () => ({ modelFallback: true, chains: { "anthropic-subscription/claude-fable-5-1": chain } }),
		registry,
		cooldowns: new SelectorCooldowns(() => 0),
		logger: { debug: () => {}, info: () => {}, warn: () => {} },
		switchModel: async (next) => {
			current = { model: next };
			switches.push(`${next.provider}/${next.id}`);
		},
		emit: () => {},
		getCurrentSelector: () => current,
		isAuthAvailable: () => true,
	};
	return { controller: new RetryFallbackController(deps), switches };
}

const lastResortChain = ["kimi-coding/kimi-k3", "openai-codex/gpt-6-sol!last-resort"];

describe("a last-resort rung is reachable only through a usage limit, billing or a signed-out provider (#3845)", () => {
	it("#given usage limits on both rungs #when the chain is walked #then it lands on the last-resort rung", async () => {
		const { controller, switches } = createController(lastResortChain);

		const hops = [
			await controller.tryFallback("transient", { errorMessage: ACCOUNT_LIMIT }),
			await controller.tryFallback("transient", { errorMessage: USAGE_LIMIT_JSON }),
		];

		expect({ hops, switches }).toEqual({
			hops: [true, true],
			switches: ["kimi-coding/kimi-k3", "openai-codex/gpt-6-sol"],
		});
	});

	it("#given an overload after retries on both rungs #when the chain is walked #then it ends without the last-resort rung", async () => {
		const { controller, switches } = createController(lastResortChain);

		const hops = [
			await controller.tryFallback("transient", { errorMessage: "529 overloaded_error: Overloaded" }),
			await controller.tryFallback("transient", { errorMessage: "529 overloaded_error: Overloaded" }),
		];

		expect({ hops, switches }).toEqual({ hops: [true, false], switches: ["kimi-coding/kimi-k3"] });
	});

	it("#given refusals on both rungs #when the chain is walked #then it ends without the last-resort rung", async () => {
		const { controller, switches } = createController(lastResortChain);

		const hops = [await controller.tryFallback("refusal", {}), await controller.tryFallback("refusal", {})];

		expect({ hops, switches }).toEqual({ hops: [true, false], switches: ["kimi-coding/kimi-k3"] });
	});

	it("#given a billing failure #when falling back #then the last-resort rung is eligible", async () => {
		const { controller, switches } = createController(["openai-codex/gpt-6-sol!last-resort"]);

		const switched = await controller.tryFallback("billing", {
			errorMessage: "400 Your credit balance is too low to access the Anthropic API.",
		});

		expect({ switched, switches }).toEqual({ switched: true, switches: ["openai-codex/gpt-6-sol"] });
	});

	it("#given the provider is signed out #when falling back #then the last-resort rung is eligible", async () => {
		const { controller, switches } = createController(["openai-codex/gpt-6-sol!last-resort"]);

		const switched = await controller.tryFallback("hard-error", {
			errorMessage: `${PROVIDER_NOT_CONFIGURED_PREFIX}anthropic-subscription`,
		});

		expect({ switched, switches }).toEqual({ switched: true, switches: ["openai-codex/gpt-6-sol"] });
	});

	it("#given the last-resort rung is on the spent account #when that account hits its limit #then the rung is skipped", async () => {
		const { controller, switches } = createController(["anthropic-subscription/claude-opus-5-5!last-resort"]);

		const switched = await controller.tryFallback("transient", { errorMessage: ACCOUNT_LIMIT });

		expect({ switched, switches }).toEqual({ switched: false, switches: [] });
	});

	it("#given only the last-resort rung remains #when the session asks whether a fallback exists #then the answer depends on the failure", async () => {
		const { controller } = createController(lastResortChain);
		await controller.tryFallback("transient", { errorMessage: ACCOUNT_LIMIT });

		expect({
			usageLimit: controller.canTryFallback(undefined, { errorMessage: USAGE_LIMIT_JSON }),
			overload: controller.canTryFallback(undefined, { errorMessage: "529 overloaded_error: Overloaded" }),
			noFailure: controller.canTryFallback(),
		}).toEqual({ usageLimit: true, overload: false, noFailure: false });
	});

	it("#given a last-resort entry #when the chain is validated #then it is accepted", () => {
		expect(
			validateFallbackChains({ "anthropic-subscription/claude-fable-5-1": lastResortChain }, registry),
		).toEqual([]);
	});
});
