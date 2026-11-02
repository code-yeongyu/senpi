import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { parseRetryAfterMsMarker } from "@earendil-works/pi-ai/utils/retry-hint";
import { describe, expect, it } from "vitest";
import { usageLimitResetMs } from "../../../src/core/credential-pool/reset-time.ts";
import type { AccountSlot } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	AllAccountsBlockedError,
	selectAccount,
} from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import { runFailover } from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
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

describe("the turn in which the last account goes out keeps the pool's limit scope (#5007)", () => {
	const NOW = Date.UTC(2026, 9, 30, 10);
	const pool: AccountSlot[] = [
		{ name: "alpha", source: "login", store: "claude-cli", dirId: "a".repeat(32) },
		{ name: "bravo", source: "login", store: "claude-cli", dirId: "b".repeat(32) },
	];

	it("#given one account is out for Fable only and the last one hits an account-wide limit #when the turn fails #then the pool reports a model-scoped limit", async () => {
		const replies = [
			"You've hit your Fable limit · resets Nov 3, 9am (UTC)",
			"You've hit your session limit · resets 3pm (UTC)",
		];
		let thrown: unknown;
		try {
			for await (const _event of runFailover({
				accounts: pool,
				selectFn: (accounts) => selectAccount(accounts, { sessionId: "mixed-pool", now: NOW, model: fable.id }),
				runAttempt: async function* () {
					const reply = replies.shift();
					if (reply !== undefined) throw new Error(reply);
					yield* [];
				},
				classify: classifySdkError,
				store: new InMemoryCredentialStore(),
				providerId: "anthropic-subscription",
				model: fable.id,
				now: () => NOW,
				sessionKey: "mixed-pool",
			})) {
				// drain
			}
		} catch (error) {
			thrown = error;
		}

		expect({
			limitedModel: thrown instanceof AllAccountsBlockedError ? thrown.limitedModel : undefined,
			scope:
				thrown instanceof AllAccountsBlockedError
					? usageLimitScope(withAuthGuidance(thrown, thrown.message, undefined, NOW))
					: undefined,
		}).toEqual({ limitedModel: fable.id, scope: "model" });
	});

	it("#given the pool is out for one model until a named time #when the refusal is shown #then the reset readers get that time", () => {
		const until = NOW + 26 * 60 * 60_000;
		const text = withAuthGuidance(new AllAccountsBlockedError(until, undefined, fable.id), "", undefined, NOW);

		expect({ reset: usageLimitResetMs(text, NOW), marker: parseRetryAfterMsMarker(text) }).toEqual({
			reset: until - NOW,
			marker: until - NOW,
		});
	});
});
