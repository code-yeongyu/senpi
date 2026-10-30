/**
 * senpi#4671: when the last usable account fails mid-turn, the turn keeps that account's own failure, but goal
 * mode must still learn the soonest retry from the pool refusal, as it did when the refusal was the error.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	addAccount,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	AllAccountsBlockedError,
	selectAccount,
} from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import {
	ClassifiedSdkError,
	runFailover,
} from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { providerRetryAt } from "../../../src/core/extensions/builtin/goal/provider-retry.ts";

const NOW = Date.parse("2026-10-28T12:53:51Z");

const alpha: AccountSlot = { name: "alpha", refresh: "r-a", access: "a-a", expires: NOW + 3_600_000, source: "login" };
const bravo: AccountSlot = {
	name: "bravo",
	refresh: "r-b",
	access: "a-b",
	expires: NOW + 3_600_000,
	source: "login",
	blockedUntil: NOW + 2 * 60 * 60 * 1_000,
	blockReason: "rate_limit",
	blockedAt: NOW - 60_000,
};

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

afterEach(() => resetSdkBoundary());

/** The error the real failover throws when alpha hits a rate limit while bravo is already blocked. */
async function midTurnExhaustion(): Promise<ClassifiedSdkError> {
	const store = new InMemoryCredentialStore();
	await store.modify("anthropic-subscription", async () =>
		[alpha, bravo].reduce<AnthropicSubscriptionCredential>(
			(credential, account) => addAccount(credential, account),
			emptyCredential(),
		),
	);
	const run = runFailover({
		accounts: [alpha, bravo],
		selectFn: (pool) => selectAccount(pool, { sessionId: "pool-block-retry", now: NOW }),
		runAttempt: async function* () {
			yield* [];
			throw new Error("rate_limit");
		},
		classify: classifySdkError,
		store,
		providerId: "anthropic-subscription",
		now: () => NOW,
	});
	try {
		for await (const _event of run);
	} catch (error) {
		if (error instanceof ClassifiedSdkError) return error;
		throw error;
	}
	throw new Error("failover did not fail");
}

describe("a mid-turn pool exhaustion keeps the soonest retry (senpi#4671)", () => {
	it("leaves the pool refusal reachable and its retry time in the turn's error", async () => {
		const failure = await midTurnExhaustion();
		const soonest = failure.poolState?.soonestUnblockAt;
		expect(soonest).toBeGreaterThan(NOW);

		overrideSdkBoundary({
			query: () => ({
				async *[Symbol.asyncIterator]() {
					yield* [];
					throw failure;
				},
				async interrupt() {},
				close() {},
			}),
		});
		const message = await streamAnthropicSubscription(model, { messages: [] }, { cwd: process.cwd() }).result();

		expect(message.errorMessage).toContain("rate_limit");
		expect(providerRetryAt([message], NOW)).toBe(soonest);
		expect(failure.cause).toBeInstanceOf(AllAccountsBlockedError);
	});
});
