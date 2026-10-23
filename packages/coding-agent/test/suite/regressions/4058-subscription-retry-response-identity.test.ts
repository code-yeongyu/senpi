import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { _resetLongContextForTesting } from "../../../src/core/extensions/builtin/anthropic-subscription/long-context.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
	type SdkQuery,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	closeSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";

const model: Model<Api> = {
	id: "claude-sonnet-4-5",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: true,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 1_000_000,
	maxTokens: 8_192,
};
const sessionId = "retry-response-identity";
const directories: string[] = [];
const envelope = {
	parent_tool_use_id: null,
	session_id: "synthetic-session",
	uuid: "11111111-1111-4111-8111-111111111111",
} as const;
type ResultUsage = Extract<SDKMessage, { type: "result"; subtype: "success" }>["usage"];
const usage = (input: number, output: number, cacheRead = 0): ResultUsage => ({
	input_tokens: input,
	output_tokens: output,
	cache_read_input_tokens: cacheRead,
	cache_creation_input_tokens: 0,
	cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
	fallback_credit: null,
	inference_geo: "",
	iterations: [],
	output_tokens_details: { thinking_tokens: 0 },
	server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
	service_tier: "standard",
	speed: "standard",
});
type AssistantBody = Extract<SDKMessage, { type: "assistant" }>["message"];
const assistant = (id: string, text: string, tokens: ResultUsage): AssistantBody => ({
	id,
	type: "message",
	role: "assistant",
	model: model.id,
	content: [{ type: "text", text, citations: null }],
	usage: tokens,
	container: null,
	context_management: null,
	diagnostics: null,
	stop_details: null,
	stop_reason: "end_turn",
	stop_sequence: null,
});

afterEach(() => {
	closeSession(sessionId, "test_cleanup");
	resetSessionRegistryBoundary();
	resetSdkBoundary();
	resetAuthLaneBoundary();
	_resetLongContextForTesting();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// senpi#4058: a discarded attempt must not supply the retained reply's identity or usage.
for (const lane of ["ambient", "managed", "resident"] as const) {
	for (const reply of ["streamed", "result-only", "no-usage"] as const) {
		it(`${lane}: response identity and usage belong to the retained ${reply} attempt`, async () => {
			const streamed = reply === "streamed";
			let attempts = 0;
			const directory = mkdtempSync(join(tmpdir(), "retry-response-"));
			directories.push(directory);
			_resetLongContextForTesting(join(directory, "long-context.json"));
			const store = new InMemoryCredentialStore();
			if (lane !== "ambient") {
				await store.modify("anthropic-subscription", async () =>
					addAccount(emptyCredential(), {
						name: "synthetic-account",
						access: "synthetic-access",
						refresh: "synthetic-refresh",
						expires: Number.MAX_SAFE_INTEGER,
						source: "login",
					}),
				);
			}
			overrideAuthLaneBoundary({ createStore: () => store, env: () => ({}) });
			const query: SdkQuery = ({ prompt }) => {
				const attempt = ++attempts;
				return {
					async *[Symbol.asyncIterator]() {
						let userMessageUuid: string | undefined;
						if (lane === "resident") {
							if (typeof prompt === "string") throw new Error("Expected resident input");
							const submitted = await prompt[Symbol.asyncIterator]().next();
							if (submitted.done || !submitted.value.uuid) throw new Error("Expected identified resident turn");
							userMessageUuid = submitted.value.uuid;
							yield { ...submitted.value, uuid: submitted.value.uuid, isReplay: true } satisfies SDKMessage;
						}
						const responseId = attempt === 1 ? "msg_failed_attempt" : "msg_successful_attempt";
						if (attempt === 1 || streamed) {
							yield {
								...envelope,
								type: "stream_event",
								event: {
									type: "message_start",
									message: {
										...assistant(responseId, "", usage(attempt, 0, attempt === 1 ? 1000 : 0)),
										content: [],
										stop_reason: null,
									},
								},
							} satisfies SDKMessage;
						}
						if (attempt === 1) {
							yield {
								...envelope,
								type: "assistant",
								error: "rate_limit",
								message: {
									...assistant(
										"synthetic-refusal",
										"Extra usage is required for long context - enable extra usage",
										usage(0, 0),
									),
									model: "<synthetic>",
								},
							} satisfies SDKMessage;
							return;
						}
						if (streamed) {
							yield {
								...envelope,
								type: "stream_event",
								event: {
									type: "content_block_start",
									index: 0,
									content_block: { type: "text", text: "", citations: null },
								},
							} satisfies SDKMessage;
							yield {
								...envelope,
								type: "stream_event",
								event: {
									type: "content_block_delta",
									index: 0,
									delta: { type: "text_delta", text: "Synthetic." },
								},
							} satisfies SDKMessage;
							yield {
								...envelope,
								type: "stream_event",
								event: { type: "content_block_stop", index: 0 },
							} satisfies SDKMessage;
						}
						const successfulAssistant = {
							...envelope,
							type: "assistant",
							message: assistant(responseId, "Synthetic.", usage(2, 21)),
						} satisfies SDKMessage;
						const successfulResult = {
							...envelope,
							type: "result",
							subtype: "success",
							is_error: false,
							result: "Synthetic.",
							stop_reason: "end_turn",
							usage: usage(2, 21),
							duration_ms: 1,
							duration_api_ms: 1,
							num_turns: 1,
							total_cost_usd: 0,
							modelUsage: {},
							permission_denials: [],
							...(userMessageUuid === undefined ? {} : { user_message_uuid: userMessageUuid }),
						} satisfies SDKMessage;
						if (reply === "no-usage") {
							// Exercise the boundary's missing-metadata path, not zero-valued usage
							// that would overwrite the discarded attempt even without a reset.
							expect(Reflect.deleteProperty(successfulAssistant.message, "usage")).toBe(true);
							expect(Reflect.deleteProperty(successfulResult, "usage")).toBe(true);
						}
						yield successfulAssistant;
						yield successfulResult;
					},
					async interrupt() {},
					close() {},
				};
			};
			overrideSdkBoundary({ query });
			overrideSessionRegistryBoundary({ queryFactory: query });
			const stream = streamAnthropicSubscription(
				model,
				{ messages: [{ role: "user", content: "Synthetic prompt.", timestamp: 1 }] },
				lane === "resident" ? { streamKind: "main", sessionId } : undefined,
			);
			for await (const _ of stream) {
			}
			const output = await stream.result();
			expect(output.stopReason, output.errorMessage).toBe("stop");
			expect(attempts).toBe(2);
			if (reply === "no-usage") {
				expect(output.usage.contextUsage).toBeNull();
				expect(output.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, totalTokens: 0 });
			} else {
				expect(output.usage).toMatchObject({ input: 2, output: 21, cacheRead: 0, totalTokens: 23 });
			}
			expect(output.responseId).toBe("msg_successful_attempt");
			expect(output.content).toEqual([{ type: "text", text: "Synthetic." }]);
		});
	}
}
