/**
 * senpi#4672: a request the account pool refuses locally, or a classified SDK failure, ends the turn with a
 * provider diagnostic, so agent_end reports a category (and the soonest retry) instead of `unknown`.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { providerFailureOf } from "../../../src/core/provider-failure.ts";
import { AllAccountsBlockedError } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import { ClassifiedSdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";

const SOONEST = Date.parse("2026-10-28T13:08:45.000Z");

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

function failingQuery(error: unknown): SdkQuery {
	return () => ({
		async *[Symbol.asyncIterator]() {
			yield* [];
			throw error;
		},
		async interrupt() {},
		close() {},
	});
}

async function failedTurn(error: unknown) {
	overrideSdkBoundary({ query: failingQuery(error) });
	const message = await streamAnthropicSubscription(model, { messages: [] }, { cwd: process.cwd() }).result();
	return providerFailureOf([message]);
}

afterEach(() => resetSdkBoundary());

describe("a refused account pool is a classified failure (senpi#4672)", () => {
	it("reports a pool waiting on a limit as rate_limit with the soonest retry", async () => {
		const failure = await failedTurn(new AllAccountsBlockedError(SOONEST));

		expect(failure?.category).not.toBe("unknown");
		expect(failure).toMatchObject({ category: "rate_limit", code: "account_pool_blocked", resetsAt: SOONEST });
	});

	it("reports a pool where every account needs a new login as auth", async () => {
		const failure = await failedTurn(new AllAccountsBlockedError(SOONEST, "auth_error"));

		expect(failure).toMatchObject({ category: "auth", code: "account_pool_auth_blocked" });
	});

	it.each([
		["authentication_failed", "auth"],
		["rate_limit", "rate_limit"],
		["overloaded", "provider_unavailable"],
	] as const)("maps a classified SDK failure (%s) to %s", async (sdkError, category) => {
		const error = new ClassifiedSdkError(classifySdkError(sdkError), new Error(sdkError), false);

		expect((await failedTurn(error))?.category).toBe(category);
	});
});
