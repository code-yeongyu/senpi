/**
 * senpi#5587: an Anthropic Subscription turn refused because a replayed thinking block is bound to a different
 * conversation reports a typed invalid_request diagnostic instead of an unknown failure.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { ClassifiedSdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { providerFailureOf } from "../../../src/core/provider-failure.ts";

const RECORDED_400 = readFileSync(
	join(import.meta.dirname, "../../../../ai/test/fixtures/anthropic-thinking-binding-400.json"),
	"utf8",
);

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

describe("a thinking block bound to a different conversation (senpi#5587)", () => {
	const apiError = new Error(`API Error: 400 ${RECORDED_400.trim()}`);

	it("is an invalid_request failure, not unknown", async () => {
		expect(await failedTurn(apiError)).toMatchObject({
			category: "invalid_request",
			code: "invalid_request_error",
			httpStatus: 400,
		});
	});

	it("is recognized through the failover classification wrapper", async () => {
		expect(await failedTurn(new ClassifiedSdkError(classifySdkError(apiError), apiError, false))).toMatchObject({
			category: "invalid_request",
			httpStatus: 400,
		});
	});
});
