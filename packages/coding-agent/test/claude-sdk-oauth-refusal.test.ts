import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
} from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import {
	closeSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { streamClaudeSdkOauth } from "../src/core/extensions/builtin/claude-sdk-oauth/stream.ts";

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

const sessionId = "resident-policy-refusal";

function sdkMessage(value: unknown): SDKMessage {
	return value as SDKMessage;
}

afterEach(() => {
	closeSession(sessionId, "test_cleanup");
	resetSessionRegistryBoundary();
	resetSdkBoundary();
});

describe("Claude SDK OAuth refusals", () => {
	it("surfaces an ambient cybersecurity refusal before reading another SDK message", async () => {
		// Given: the non-resident ambient query emits the SDK's terminal refusal shape.
		overrideSdkBoundary({
			query: () => ({
				async *[Symbol.asyncIterator]() {
					yield sdkMessage({
						type: "system",
						subtype: "model_refusal_no_fallback",
						original_model: model.id,
						request_id: "request-refusal",
						api_refusal_category: "cyber",
						api_refusal_explanation: "The request was blocked by policy.",
						content: "Claude refused this request.",
						uuid: "refusal-message",
						session_id: "ambient-policy-refusal",
					});
					throw new Error("consumer read past terminal refusal");
				},
				async interrupt() {},
				close() {},
			}),
		});

		// When: the ambient lane consumes the refusal.
		const result = await streamClaudeSdkOauth(model, { messages: [] }).result();

		// Then: refusal itself terminates the stream; no watchdog is needed.
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "Claude refused this request (cyber): The request was blocked by policy.",
		});
	});

	it("surfaces the legacy assistant refusal frame", async () => {
		// Given: older CLIs expose refusal only on the assistant API message.
		overrideSdkBoundary({
			query: () => ({
				async *[Symbol.asyncIterator]() {
					yield sdkMessage({
						type: "assistant",
						message: {
							id: "assistant-refusal",
							type: "message",
							role: "assistant",
							content: [],
							stop_reason: "refusal",
							stop_details: { category: "cyber", explanation: "The request was blocked by policy." },
						},
						parent_tool_use_id: null,
						uuid: "assistant-refusal",
						session_id: "legacy-policy-refusal",
					});
					throw new Error("consumer read past terminal refusal");
				},
				async interrupt() {},
				close() {},
			}),
		});

		// When: the lane consumes the assistant refusal frame.
		const result = await streamClaudeSdkOauth(model, { messages: [] }).result();

		// Then: the legacy shape produces the same terminal refusal outcome.
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "Claude refused this request (cyber): The request was blocked by policy.",
		});
	});

	it("surfaces a resident cybersecurity refusal before reading another SDK message", async () => {
		// Given: SDK 0.3.220's structured no-fallback refusal follows the replay claim.
		const query: SdkQuery = ({ prompt }) => {
			if (typeof prompt === "string") throw new Error("Expected resident streaming input");
			return {
				async *[Symbol.asyncIterator]() {
					const submitted = await prompt[Symbol.asyncIterator]().next();
					if (submitted.done) throw new Error("Expected submitted turn");
					yield sdkMessage({ ...submitted.value, isReplay: true });
					yield sdkMessage({
						type: "system",
						subtype: "model_refusal_no_fallback",
						original_model: model.id,
						request_id: "request-refusal",
						api_refusal_category: "cyber",
						api_refusal_explanation: "The request was blocked by policy.",
						refused_user_message_uuid: submitted.value.uuid,
						content: "Claude refused this request.",
						uuid: "refusal-message",
						session_id: sessionId,
					});
					throw new Error("consumer read past terminal refusal");
				},
				async interrupt() {},
				close() {},
			};
		};
		overrideSdkBoundary({ query });
		overrideSessionRegistryBoundary({ queryFactory: query });

		// When: the resident lane consumes the refusal.
		const result = await streamClaudeSdkOauth(
			model,
			{ messages: [{ role: "user", content: "security-sensitive request", timestamp: 1 }] },
			{ sessionId, streamKind: "main" },
		).result();

		// Then: refusal itself terminates the stream; the pump never asks for another message.
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "Claude refused this request (cyber): The request was blocked by policy.",
		});
	});
});
