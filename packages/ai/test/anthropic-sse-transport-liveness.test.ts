import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";
import type { AssistantMessage } from "../src/types.ts";
import { isProviderStreamStallError, isRetryableAssistantError } from "../src/utils/retry.ts";

// senpi#4608: an SSE response whose headers arrived but whose body never delivers a byte is a dead
// transport. Any byte (an `event: ping`, a `:` comment) proves the connection alive; only content
// events prove the model started, and those stay under the agent loop's long start bound.

const encoder = new TextEncoder();

interface ControllableSse {
	response: Response;
	send(text: string): void;
	close(): void;
	cancels: unknown[];
}

function controllableSse(): ControllableSse {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const cancels: unknown[] = [];
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
		cancel(reason) {
			cancels.push(reason);
		},
	});
	return {
		response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
		send: (text) => controller.enqueue(encoder.encode(text)),
		close: () => controller.close(),
		cancels,
	};
}

function fakeClient(response: Response): Anthropic {
	return {
		beta: { messages: { create: () => ({ asResponse: async () => response }) } },
	} as unknown as Anthropic;
}

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const PING = sse("ping", { type: "ping" });
const MESSAGE_START = sse("message_start", {
	type: "message_start",
	message: {
		id: "msg_liveness",
		usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
});
const REST_OF_REPLY = [
	sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
	sse("content_block_stop", { type: "content_block_stop", index: 0 }),
	sse("message_delta", {
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	}),
	sse("message_stop", { type: "message_stop" }),
].join("");

interface Tracked {
	settled: () => boolean;
	result: Promise<AssistantMessage>;
}

function start(transport: ControllableSse, options: { streamLivenessTimeoutMs?: number } = {}): Tracked {
	const model = getModel("anthropic", "claude-haiku-4-5");
	let done = false;
	const result = streamAnthropic(
		model,
		normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
		{ client: fakeClient(transport.response), signal: cleanup.signal, ...options },
	)
		.result()
		.finally(() => {
			done = true;
		});
	return { settled: () => done, result };
}

let cleanup: AbortController;

describe("Anthropic SSE transport liveness (senpi#4608)", () => {
	beforeEach(() => {
		cleanup = new AbortController();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	});

	afterEach(() => {
		// A stream the test left hanging is torn down so no pending read outlives the case.
		cleanup.abort();
		vi.useRealTimers();
	});

	it("ends a stream whose headers arrived and whose body stays silent with a typed, retryable stall within the default liveness bound", async () => {
		const transport = controllableSse();
		const run = start(transport);

		await vi.advanceTimersByTimeAsync(89_000);
		expect(run.settled()).toBe(false);
		await vi.advanceTimersByTimeAsync(1_001);
		expect(run.settled()).toBe(true);

		const message = await run.result;
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("SSE transport liveness timeout after 90000ms (no bytes received)");
		expect(isProviderStreamStallError(message)).toBe(true);
		expect(isRetryableAssistantError(message)).toBe(true);
	});

	it("honors a configured liveness bound", async () => {
		const transport = controllableSse();
		const run = start(transport, { streamLivenessTimeoutMs: 20_000 });

		await vi.advanceTimersByTimeAsync(20_001);
		expect(run.settled()).toBe(true);
		expect((await run.result).errorMessage).toBe("SSE transport liveness timeout after 20000ms (no bytes received)");
	});

	it("cancels the response body on a liveness failure so the connection is released", async () => {
		const transport = controllableSse();
		const run = start(transport);

		await vi.advanceTimersByTimeAsync(90_001);
		await run.result;
		expect(transport.cancels).toHaveLength(1);
		const reason = transport.cancels[0] as Error;
		expect(reason).toBeInstanceOf(Error);
		expect(reason.name).toBe("SseTransportLivenessError");
	});

	it("keeps a slow but alive stream: pings and comments past the liveness and start bounds, then a late reply", async () => {
		const transport = controllableSse();
		const run = start(transport);

		// Six minutes before the first content event: longer than the 90 s liveness bound and the
		// 300 s default start bound, with a keepalive byte every 30 s.
		for (let second = 30; second <= 360; second += 30) {
			await vi.advanceTimersByTimeAsync(30_000);
			transport.send(second % 60 === 0 ? PING : ": keepalive\n\n");
			expect(run.settled()).toBe(false);
		}
		transport.send(MESSAGE_START);
		transport.send(REST_OF_REPLY);
		transport.close();

		const message = await run.result;
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(transport.cancels).toHaveLength(0);
	});

	it("detects a transport that dies after the first event the same way", async () => {
		const transport = controllableSse();
		const run = start(transport);

		transport.send(MESSAGE_START);
		await vi.advanceTimersByTimeAsync(60_000);
		transport.send(PING);
		await vi.advanceTimersByTimeAsync(89_000);
		expect(run.settled()).toBe(false);
		await vi.advanceTimersByTimeAsync(1_001);

		expect((await run.result).errorMessage).toBe("SSE transport liveness timeout after 90000ms (no bytes received)");
		expect(transport.cancels).toHaveLength(1);
	});

	it("leaves silence unbounded at this layer when the liveness bound is disabled with 0", async () => {
		const transport = controllableSse();
		const run = start(transport, { streamLivenessTimeoutMs: 0 });

		await vi.advanceTimersByTimeAsync(600_000);
		expect(run.settled()).toBe(false);
		transport.send(MESSAGE_START);
		transport.send(REST_OF_REPLY);
		transport.close();
		expect((await run.result).stopReason).toBe("stop");
	});
});
