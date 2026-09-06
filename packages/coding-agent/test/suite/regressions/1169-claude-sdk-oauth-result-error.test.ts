import { describe, expect, it } from "vitest";
import { sdkResultFailure } from "../../../src/core/extensions/builtin/claude-sdk-oauth/errors.ts";
import { ClassifiedSdkError } from "../../../src/core/extensions/builtin/claude-sdk-oauth/failover.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { streamClaudeSdkOauth } from "../../../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";

function message(value: unknown): SDKMessage {
	return value as SDKMessage;
}

const model = {
	id: "claude-test",
	name: "Claude",
	api: "claude-sdk-oauth",
	provider: "claude-sdk-oauth",
	baseUrl: "",
	reasoning: true,
	input: ["text"] as ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

describe("regression #1169: Claude SDK is_error results", () => {
	it("keeps the usage when the managed lane's failover wrapper throws the failed result", async () => {
		// The managed (oauth-slots) lane classifies the is_error result inside
		// runFailover and throws a ClassifiedSdkError before stream.ts ever sees
		// the result message; the billed usage must survive that boundary.
		const failed = sdkResultFailure(
			message({
				type: "result",
				subtype: "success",
				is_error: true,
				api_error_status: 429,
				result: "API failure",
				usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 11, cache_creation_input_tokens: 5 },
			}) as Extract<SDKMessage, { type: "result" }>,
		);
		overrideSdkBoundary({
			query: () => ({
				[Symbol.asyncIterator]() {
					return {
						next: () =>
							Promise.reject(new ClassifiedSdkError({ kind: "rate_limit", retryable: true }, failed, false)),
					};
				},
				async interrupt() {},
				close() {},
			}),
		});
		try {
			const failure = await streamClaudeSdkOauth(model, { messages: [] }).result();
			expect(failure.stopReason).toBe("error");
			expect(failure.errorMessage).toContain("API failure");
			expect(failure.usage).toMatchObject({ input: 7, output: 3, cacheRead: 11, cacheWrite: 5, totalTokens: 26 });
		} finally {
			resetSdkBoundary();
		}
	});

	it("keeps the usage an is_error result reports", async () => {
		overrideSdkBoundary({
			query: () => ({
				async *[Symbol.asyncIterator]() {
					yield message({
						type: "result",
						subtype: "success",
						is_error: true,
						api_error_status: 429,
						result: "API failure",
						usage: {
							input_tokens: 7,
							output_tokens: 3,
							cache_read_input_tokens: 11,
							cache_creation_input_tokens: 5,
						},
					});
				},
				async interrupt() {},
				close() {},
			}),
		});
		try {
			const failure = await streamClaudeSdkOauth(model, { messages: [] }).result();
			expect(failure.stopReason).toBe("error");
			expect(failure.usage).toMatchObject({ input: 7, output: 3, cacheRead: 11, cacheWrite: 5, totalTokens: 26 });
		} finally {
			resetSdkBoundary();
		}
	});

	it("fails a success-subtype session limit and preserves ordinary success", async () => {
		overrideSdkBoundary({
			query: () => ({
				async *[Symbol.asyncIterator]() {
					yield message({
						type: "result",
						subtype: "success",
						is_error: true,
						api_error_status: 429,
						terminal_reason: "blocking_limit",
						result: "You've hit your session limit · resets 2:50pm (Asia/Seoul)",
					});
				},
				async interrupt() {},
				close() {},
			}),
		});
		try {
			const failure = await streamClaudeSdkOauth(model, { messages: [] }).result();
			expect(failure.stopReason).toBe("error");
			expect(failure.errorMessage).toContain("session limit");
		} finally {
			resetSdkBoundary();
		}

		overrideSdkBoundary({
			query: () => ({
				async *[Symbol.asyncIterator]() {
					yield message({ type: "result", subtype: "success", is_error: false, result: "ordinary answer" });
				},
				async interrupt() {},
				close() {},
			}),
		});
		try {
			const success = await streamClaudeSdkOauth(model, { messages: [] }).result();
			expect(success.stopReason).not.toBe("error");
			expect(success.content).toEqual([{ type: "text", text: "ordinary answer" }]);
		} finally {
			resetSdkBoundary();
		}
	});
});
