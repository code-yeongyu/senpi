import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { calculateContextTokens as aiContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { afterEach, describe, expect, it } from "vitest";
import {
	calculateContextTokens,
	estimateContextTokens,
	shouldCompact,
} from "../../../src/core/compaction/compaction.ts";
import {
	overrideSdkBoundary,
	resetSdkBoundary,
	type SDKMessage,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { streamAnthropicSubscription } from "../../../src/core/extensions/builtin/anthropic-subscription/stream.ts";
import { emptyOutput } from "../../../src/core/extensions/builtin/anthropic-subscription/stream-protocol.ts";
import { buildRpcSessionState } from "../../../src/modes/rpc/rpc-session-state.ts";
import { createHarness } from "../harness.ts";

const model: Model<Api> = {
	id: "claude-test",
	name: "Claude test",
	api: "claude-sdk-oauth",
	provider: "anthropic-subscription",
	baseUrl: "claude-sdk-oauth",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
	contextWindow: 1_000_000,
	maxTokens: 8_192,
};

// The fake lives at the SDK boundary; accounting and session consumers run unchanged.
function sdkMessage(value: unknown): SDKMessage {
	return value as SDKMessage;
}

function request(cacheRead: number, output: number): SDKMessage[] {
	return [
		sdkMessage({
			type: "stream_event",
			event: {
				type: "message_start",
				message: {
					id: `request-${cacheRead}`,
					usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: cacheRead },
				},
			},
		}),
		sdkMessage({
			type: "stream_event",
			event: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: output } },
		}),
		sdkMessage({
			type: "assistant",
			message: {
				id: `request-${cacheRead}`,
				usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: cacheRead },
			},
		}),
	];
}

function result(cacheRead: number, output: number): SDKMessage {
	return sdkMessage({
		type: "result",
		subtype: "success",
		result: "done",
		stop_reason: "end_turn",
		usage: { input_tokens: 0, output_tokens: output, cache_read_input_tokens: cacheRead },
	});
}

function script(messages: SDKMessage[], beforeResult?: () => Promise<void>): void {
	overrideSdkBoundary({
		query: () => ({
			async *[Symbol.asyncIterator]() {
				for (const message of messages) {
					if (message.type === "result") await beforeResult?.();
					yield message;
				}
			},
			async interrupt() {},
			close() {},
		}),
	});
}

afterEach(resetSdkBoundary);

// oh-my-openagent#10792: terminal SDK usage bills both requests, but only the last occupies context.
describe("subscription request context versus query billing", () => {
	it.each(["tool output", "image"] as const)("keeps context stable after a large %s turn", async (shape) => {
		const prior = emptyOutput(model);
		prior.content = [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "fixture" } }];
		prior.stopReason = "toolUse";
		prior.timestamp = 1;
		const context: Context = {
			messages: [
				prior,
				{
					role: "toolResult",
					toolCallId: "read-1",
					toolName: "read",
					content:
						shape === "tool output"
							? [{ type: "text", text: "x".repeat(40_000) }]
							: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		const atResult = Promise.withResolvers<void>();
		const releaseResult = Promise.withResolvers<void>();
		script([...request(350_000, 100), ...request(352_000, 200), result(702_000, 300)], async () => {
			atResult.resolve();
			await releaseResult.promise;
		});
		const harness = await createHarness({ models: [{ id: "context-test", contextWindow: 1_000_000 }] });
		const stream = streamAnthropicSubscription(model, context, { cwd: process.cwd() });
		try {
			const first = await stream[Symbol.asyncIterator]().next();
			if (first.done || first.value.type !== "start") throw new Error("SDK stream did not start");
			await Promise.race([
				atResult.promise,
				stream.result().then(() => {
					throw new Error("SDK stream ended before the result gate");
				}),
			]);
			harness.agent.state.messages = [...context.messages, first.value.partial];
			expect(harness.session.getContextUsage()?.percent).toBe(35.22);
			expect(buildRpcSessionState(harness.session).contextUsage?.tokens).toBe(352_200);

			releaseResult.resolve();
			const message = await stream.result();
			// Read the same live message after terminal billing, before any later request can correct it.
			expect(harness.session.getContextUsage()?.percent).toBe(35.22);
			expect(message.stopReason).toBe("stop");
			expect(calculateContextTokens(message.usage)).toBe(352_200);
			expect(aiContextTokens(message.usage)).toBe(352_200);
			expect(estimateContextTokens([...context.messages, message]).tokens).toBe(352_200);
			expect(
				shouldCompact(calculateContextTokens(message.usage), 1_000_000, {
					enabled: true,
					reserveTokens: 300_000,
					keepRecentTokens: 20_000,
				}),
			).toBe(false);
			expect(isContextOverflow(message, 600_000)).toBe(false);
			expect(message.usage).toMatchObject({ cacheRead: 702_000, output: 300, totalTokens: 702_300 });
			expect(message.usage.cost.total).toBeCloseTo(0.2151);
			for (const entry of [...context.messages, message]) harness.sessionManager.appendMessage(entry);
			harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			expect(harness.session.getContextUsage()?.percent).toBe(35.22);
			expect(buildRpcSessionState(harness.session).contextUsage?.tokens).toBe(352_200);
			expect(harness.session.getSessionStats().tokens.cacheRead).toBe(702_000);
			expect(buildRpcSessionState(harness.session).usageTotals.cacheRead).toBe(702_000);

			// The next single-request update must not "correct" a falsely doubled terminal value.
			script([...request(353_000, 100), result(353_000, 100)]);
			const next = await streamAnthropicSubscription(
				model,
				{ messages: [...context.messages, message] },
				{ cwd: process.cwd() },
			).result();
			harness.sessionManager.appendMessage(next);
			harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			expect(harness.session.getContextUsage()?.tokens).toBe(353_100);
			expect(harness.session.getSessionStats().tokens.cacheRead).toBe(1_055_000);
		} finally {
			releaseResult.resolve();
			await stream.result();
			harness.cleanup();
		}
	});

	it("uses the latest assistant snapshot when partial events are absent", async () => {
		script([
			sdkMessage({
				type: "assistant",
				message: { id: "last", usage: { input_tokens: 12, output_tokens: 0, cache_read_input_tokens: 352_000 } },
			}),
			result(702_000, 300),
		]);
		const message = await streamAnthropicSubscription(model, { messages: [] }, { cwd: process.cwd() }).result();
		expect(calculateContextTokens(message.usage)).toBe(352_012);
		expect(message.usage.cacheRead).toBe(702_000);
	});

	it("estimates result-only context instead of treating cumulative billing as a measurement", async () => {
		script([result(702_000, 300)]);
		const context: Context = { messages: [{ role: "user", content: "seed", timestamp: 1 }] };
		const message = await streamAnthropicSubscription(model, context, { cwd: process.cwd() }).result();
		expect(estimateContextTokens([...context.messages, message]).tokens).toBe(2);
		expect(isContextOverflow(message, 600_000)).toBe(false);
		expect(message.usage.totalTokens).toBe(702_300);
	});

	it("retains query billing on a failed terminal result without inflating request context", async () => {
		script([
			...request(350_000, 100),
			...request(352_000, 200),
			sdkMessage({
				type: "result",
				subtype: "error_max_turns",
				errors: ["turn budget exhausted"],
				usage: { input_tokens: 0, output_tokens: 300, cache_read_input_tokens: 702_000 },
			}),
		]);
		const message = await streamAnthropicSubscription(model, { messages: [] }, { cwd: process.cwd() }).result();
		expect(message.stopReason).toBe("error");
		expect(message.usage.totalTokens).toBe(702_300);
		expect(message.usage.cost.total).toBeCloseTo(0.2151);
		expect(calculateContextTokens(message.usage)).toBe(352_200);
	});

	it("clears omitted cache and output counters at a new request boundary", async () => {
		script([
			...request(350_000, 100),
			sdkMessage({
				type: "stream_event",
				event: { type: "message_start", message: { usage: { input_tokens: 20 } } },
			}),
			result(350_000, 100),
		]);
		const message = await streamAnthropicSubscription(model, { messages: [] }, { cwd: process.cwd() }).result();
		expect(calculateContextTokens(message.usage)).toBe(20);
		expect(message.usage.cacheRead).toBe(350_000);
	});

	it("invalidates the session context cache when only the request measurement changes", async () => {
		const harness = await createHarness();
		try {
			const message: AssistantMessage = emptyOutput(model);
			Object.assign(message.usage, {
				input: 700_000,
				totalTokens: 700_000,
				contextUsage: { input: 350_000, output: 0 },
			});
			harness.agent.state.messages = [message];
			expect(harness.session.getContextUsage()?.tokens).toBe(350_000);
			Object.assign(message.usage, { contextUsage: { input: 351_000, output: 0 } });
			expect(harness.session.getContextUsage()?.tokens).toBe(351_000);
		} finally {
			harness.cleanup();
		}
	});
});
