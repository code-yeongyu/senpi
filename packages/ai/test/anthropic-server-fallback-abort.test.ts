/**
 * Client-side abort on Anthropic server-side fallback receipts
 * (`server-side-fallback-2026-06-01` / `-2026-07-01`).
 *
 * When the API silently retries a classifier-declined request on a substitute
 * model, it marks the handoff with a `fallback` content block. Honoring that
 * response means paying for a model the caller never asked for, so senpi aborts
 * the stream at the receipt and re-classifies the turn as a classifier refusal,
 * which routes it into the caller's own fallback chain.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { buildBaseOptions } from "../src/api/simple-options.ts";
import { getModel } from "../src/compat.ts";
import type { Context, ProviderNativeContent } from "../src/types.ts";

const encoder = new TextEncoder();
const SUBSTITUTE_TEXT = "SUBSTITUTE_MODEL_OUTPUT";

interface SseEvent {
	event: string;
	data: string;
}

interface FakeBody {
	response: Response;
	chunksDelivered: () => number;
	cancelled: () => boolean;
}

/**
 * One SSE event per `pull`, so "how far did the client read" is observable.
 * `onChunk` fires after a chunk is enqueued, which lets a test interleave an
 * external abort at an exact stream position.
 */
function createChunkedSseResponse(events: readonly SseEvent[], onChunk?: (index: number) => void): FakeBody {
	let delivered = 0;
	let cancelled = false;
	let next = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (next >= events.length) {
				controller.close();
				return;
			}
			const index = next++;
			controller.enqueue(encoder.encode(`event: ${events[index].event}\ndata: ${events[index].data}\n\n`));
			delivered++;
			onChunk?.(index);
		},
		cancel() {
			cancelled = true;
		},
	});
	return {
		response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
		chunksDelivered: () => delivered,
		cancelled: () => cancelled,
	};
}

function createFakeAnthropicClient(response: Response, captureSignal?: (signal?: AbortSignal) => void): Anthropic {
	return {
		messages: {
			create: (_params: unknown, requestOptions?: { signal?: AbortSignal }) => {
				captureSignal?.(requestOptions?.signal);
				return { asResponse: async () => response };
			},
		},
	} as unknown as Anthropic;
}

const context: Context = { messages: [{ role: "user", content: "audit this binary", timestamp: 1 }] };

function messageStart(model: string, usage?: Record<string, unknown>): SseEvent {
	return {
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_fallback_test",
				model,
				usage: {
					input_tokens: 412,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
					...usage,
				},
			},
		}),
	};
}

const fallbackReceiptBlock: SseEvent = {
	event: "content_block_start",
	data: JSON.stringify({
		type: "content_block_start",
		index: 0,
		content_block: {
			type: "fallback",
			from: { model: "claude-fable-5" },
			to: { model: "claude-opus-4-8" },
		},
	}),
};

const substituteOutputEvents: readonly SseEvent[] = [
	{
		event: "content_block_start",
		data: JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({
			type: "content_block_delta",
			index: 1,
			delta: { type: "text_delta", text: SUBSTITUTE_TEXT },
		}),
	},
	{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 1 }) },
	{
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 412, output_tokens: 264 },
		}),
	},
	{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
];

const midStreamReceiptEvents: readonly SseEvent[] = [
	messageStart("claude-fable-5"),
	fallbackReceiptBlock,
	...substituteOutputEvents,
];

describe("Anthropic server-side fallback receipt abort", () => {
	it("keeps the receipt as a provider-native audit block when the option is absent", async () => {
		// Characterization: pins today's honor-the-fallback behavior, which the
		// `abortServerSideFallback: false` escape hatch must keep working.
		const model = getModel("anthropic", "claude-fable-5");
		const body = createChunkedSseResponse(midStreamReceiptEvents);
		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(body.response),
		}).result();

		expect(result.stopReason).toBe("stop");
		const receipt = result.content.find(
			(block): block is ProviderNativeContent => block.type === "providerNative" && block.subtype === "fallback",
		);
		expect(receipt).toBeDefined();
		expect(JSON.stringify(result.content)).toContain(SUBSTITUTE_TEXT);
	});

	it("aborts at the receipt and classifies the turn as a classifier refusal", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		let transportSignal: AbortSignal | undefined;
		const body = createChunkedSseResponse(midStreamReceiptEvents);

		const result = await streamAnthropic(model, context, {
			abortServerSideFallback: true,
			client: createFakeAnthropicClient(body.response, (signal) => {
				transportSignal = signal;
			}),
		}).result();

		// Refusal classification is what routes the turn into the caller's chain.
		expect(result.stopReason).toBe("error");
		expect(result.stopDetails).toEqual({
			type: "refusal",
			explanation: "Server-side fallback (claude-fable-5 -> claude-opus-4-8) aborted by client policy",
		});
		expect(result.content).toEqual([]);
		expect(JSON.stringify(result)).not.toContain(SUBSTITUTE_TEXT);
		// The transport signal is aborted, which is what cancels the upstream request.
		expect(transportSignal?.aborted).toBe(true);
		expect(body.chunksDelivered()).toBeLessThan(midStreamReceiptEvents.length);

		const diagnostics = result.diagnostics ?? [];
		expect(diagnostics.find((entry) => entry.type === "server_fallback_aborted")?.details).toEqual({
			from: "claude-fable-5",
			to: "claude-opus-4-8",
		});
		// Per-attempt usage never arrives on an aborted stream, so cost is unknowable.
		expect(diagnostics.some((entry) => entry.type === "billing_incomplete_after_client_abort")).toBe(true);
	});

	it("lets a caller abort racing the receipt win over the refusal classification", async () => {
		// Esc during a turn that also carries a receipt must stay an abort: turning
		// it into a refusal would trigger an unwanted fallback retry.
		const model = getModel("anthropic", "claude-fable-5");
		const callerAbort = new AbortController();
		const receiptIndex = midStreamReceiptEvents.indexOf(fallbackReceiptBlock);
		const body = createChunkedSseResponse(midStreamReceiptEvents, (index) => {
			if (index === receiptIndex) callerAbort.abort();
		});

		const result = await streamAnthropic(model, context, {
			abortServerSideFallback: true,
			signal: callerAbort.signal,
			client: createFakeAnthropicClient(body.response),
		}).result();

		expect(result.stopReason).toBe("aborted");
		expect(result.stopDetails).toBeUndefined();
		expect(result.diagnostics?.some((entry) => entry.type === "server_fallback_aborted")).not.toBe(true);
	});
});

describe("Anthropic sticky-served fallback detection", () => {
	const stickyIterations = [
		{ type: "message", model: "claude-fable-5", input_tokens: 535, output_tokens: 0 },
		{ type: "fallback_message", model: "claude-opus-4-8", input_tokens: 412, output_tokens: 264 },
	];

	it("aborts when message_start usage reports a fallback_message attempt", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const body = createChunkedSseResponse([
			messageStart("claude-opus-4-8", { iterations: stickyIterations }),
			...substituteOutputEvents,
		]);

		const result = await streamAnthropic(model, context, {
			abortServerSideFallback: true,
			client: createFakeAnthropicClient(body.response),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.stopDetails).toEqual({
			type: "refusal",
			explanation: "Server-side fallback (claude-fable-5 -> claude-opus-4-8) aborted by client policy",
		});
		expect(result.content).toEqual([]);
		expect(JSON.stringify(result)).not.toContain(SUBSTITUTE_TEXT);
		expect(body.chunksDelivered()).toBeLessThan(1 + substituteOutputEvents.length);
	});

	it("does not abort when every usage iteration is a normal attempt", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const body = createChunkedSseResponse([
			messageStart("claude-fable-5", {
				iterations: [{ type: "message", model: "claude-fable-5", input_tokens: 535, output_tokens: 264 }],
			}),
			...substituteOutputEvents,
		]);

		const result = await streamAnthropic(model, context, {
			abortServerSideFallback: true,
			client: createFakeAnthropicClient(body.response),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(JSON.stringify(result.content)).toContain(SUBSTITUTE_TEXT);
	});

	it("does not abort on a canonicalized served-model string with no fallback iteration", async () => {
		// Gateways and Bedrock-style endpoints rewrite the model id, so a bare
		// model mismatch is not evidence of a fallback and must never abort.
		const model = getModel("anthropic", "claude-fable-5");
		const body = createChunkedSseResponse([messageStart("anthropic.claude-fable-5-v1:0"), ...substituteOutputEvents]);

		const result = await streamAnthropic(model, context, {
			abortServerSideFallback: true,
			client: createFakeAnthropicClient(body.response),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(JSON.stringify(result.content)).toContain(SUBSTITUTE_TEXT);
	});

	it("ignores a fallback_message attempt when the option is off", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const body = createChunkedSseResponse([
			messageStart("claude-opus-4-8", { iterations: stickyIterations }),
			...substituteOutputEvents,
		]);

		const result = await streamAnthropic(model, context, {
			client: createFakeAnthropicClient(body.response),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(JSON.stringify(result.content)).toContain(SUBSTITUTE_TEXT);
	});
});

describe("abortServerSideFallback option seam", () => {
	it("survives buildBaseOptions, which copies a fixed field list", () => {
		const model = getModel("anthropic", "claude-fable-5");
		expect(buildBaseOptions(model, context, { abortServerSideFallback: true }).abortServerSideFallback).toBe(true);
		expect(buildBaseOptions(model, context, { abortServerSideFallback: false }).abortServerSideFallback).toBe(false);
		expect(buildBaseOptions(model, context, {}).abortServerSideFallback).toBeUndefined();
	});
});
