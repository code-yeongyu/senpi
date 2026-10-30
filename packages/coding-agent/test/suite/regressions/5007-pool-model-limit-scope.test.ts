import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AllAccountsBlockedError } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { withAuthGuidance } from "../../../src/core/extensions/builtin/anthropic-subscription/stream-guidance.ts";
import {
	RetryFallbackController,
	type RetryFallbackControllerDeps,
} from "../../../src/core/retry-fallback/controller.ts";
import { SelectorCooldowns } from "../../../src/core/retry-fallback/cooldown.ts";
import { usageLimitScope } from "../../../src/core/retry-fallback/usage-limit.ts";

function model(provider: string, id: string): Model<Api> {
	return { ...getModel("anthropic", "claude-opus-4-5"), provider, id };
}

const fable = model("anthropic-subscription", "claude-fable-5-1");
const opus = model("anthropic-subscription", "claude-opus-5-5");
const kimi = model("kimi-coding", "kimi-k3");
const models = [fable, opus, kimi];
const RESET_AT = Date.UTC(2026, 9, 31, 6);

function shown(error: AllAccountsBlockedError): string {
	return withAuthGuidance(error, error.message);
}

function createController() {
	let current: { model: Model<Api> } = { model: fable };
	const events: unknown[] = [];
	const deps: RetryFallbackControllerDeps = {
		getSettings: () => ({
			modelFallback: true,
			chains: {
				"anthropic-subscription/claude-fable-5-1": [
					"anthropic-subscription/claude-opus-5-5",
					"kimi-coding/kimi-k3",
				],
			},
		}),
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

describe("account pool blocked for one model reaches the fallback chain as a model-scoped limit", () => {
	it("#given every account is out for Fable only #when the pool refuses the turn #then the shown error is a model-scoped usage limit", () => {
		const error = new AllAccountsBlockedError(RESET_AT, undefined, fable.id);

		expect(usageLimitScope(shown(error))).toBe("model");
	});

	it("#given every account is out for Fable only #when falling back #then Opus on the same accounts serves and only Fable is marked", async () => {
		const { controller, events, current } = createController();

		const switched = await controller.tryFallback("hard-error", {
			errorMessage: shown(new AllAccountsBlockedError(RESET_AT, undefined, fable.id)),
		});

		expect({
			switched,
			model: `${current().provider}/${current().id}`,
			events,
			providerSpent: controller.isProviderSpent(fable.provider),
		}).toEqual({
			switched: true,
			model: "anthropic-subscription/claude-opus-5-5",
			events: [
				expect.objectContaining({
					type: "retry_fallback_applied",
					to: "anthropic-subscription/claude-opus-5-5",
					limit: "model",
				}),
			],
			providerSpent: false,
		});
	});

	it("#given every account is auth-blocked #when the pool refuses the turn #then it is not read as a usage limit", () => {
		expect(usageLimitScope(shown(new AllAccountsBlockedError(undefined, "auth_error")))).toBeUndefined();
	});
});
