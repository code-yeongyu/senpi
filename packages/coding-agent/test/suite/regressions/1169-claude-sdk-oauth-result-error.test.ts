import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { streamClaudeSdkOauth } from "../../../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "claude-sdk-oauth",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

function sdkMessage(value: unknown): SDKMessage {
	return value as SDKMessage;
}

function queryWithResult(result: SDKMessage): SdkQuery {
	return () => ({
		async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
			yield result;
		},
		async interrupt() {},
		close() {},
	});
}

afterEach(resetSdkBoundary);

describe("issue #1169: Claude SDK success results with is_error", () => {
	it("keeps an ordinary non-error success result successful", async () => {
		// Given: the SDK's ordinary terminal success result.
		overrideSdkBoundary({
			query: queryWithResult(
				sdkMessage({
					type: "result",
					subtype: "success",
					is_error: false,
					api_error_status: null,
					terminal_reason: "completed",
					result: "ordinary answer",
				}),
			),
		});

		// When: the authoritative Claude SDK stream boundary consumes it.
		const result = await streamClaudeSdkOauth(model, { messages: [] }).result();

		// Then: its text remains a successful assistant response.
		expect(result).toMatchObject({
			stopReason: "stop",
			content: [{ type: "text", text: "ordinary answer" }],
		});
	});

	it("reports a 429 session-limit success result with is_error as an error", async () => {
		// Given: the SDK's documented API-error shape despite subtype success.
		overrideSdkBoundary({
			query: queryWithResult(
				sdkMessage({
					type: "result",
					subtype: "success",
					is_error: true,
					api_error_status: 429,
					terminal_reason: "blocking_limit",
					result: "session limit reached",
				}),
			),
		});

		// When: the authoritative Claude SDK stream boundary consumes it.
		const result = await streamClaudeSdkOauth(model, { messages: [] }).result();

		// Then: it must not be emitted as a completed assistant response.
		expect(result.stopReason).toBe("error");
	});
});
