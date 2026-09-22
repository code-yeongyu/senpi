import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeChatGptSubscriptionWebSocketSessions,
	resetChatGptSubscriptionWebSocketDebugStats,
	stream as streamOpenAICodexResponses,
} from "../src/api/openai-codex-responses.ts";
import {
	formatResponsesCompletionStall,
	RESPONSES_COMPLETION_GRACE_MS,
	withResponsesCompletionGrace,
} from "../src/api/responses-completion-grace.ts";
import type { Context, Model } from "../src/types.ts";
import { isProviderStreamStallError, isRetryableAssistantError } from "../src/utils/retry.ts";

interface Event {
	readonly type: string;
}

function scriptedSource(script: readonly (Event | "hang")[]) {
	let returned = false;
	async function* generate(): AsyncGenerator<Event> {
		try {
			for (const step of script) {
				if (step === "hang") await new Promise<never>(() => {});
				else yield step;
			}
		} finally {
			returned = true;
		}
	}
	return { iterable: generate(), wasReturned: () => returned };
}

async function collect(iterable: AsyncIterable<Event>): Promise<{ types: string[]; error?: unknown }> {
	const types: string[] = [];
	try {
		for await (const event of iterable) types.push(event.type);
		return { types };
	} catch (error) {
		return { types, error };
	}
}

const added = { type: "response.output_item.added" };
const done = { type: "response.output_item.done" };
const completed = { type: "response.completed" };

afterEach(() => {
	vi.unstubAllGlobals();
	closeChatGptSubscriptionWebSocketSessions();
	resetChatGptSubscriptionWebSocketDebugStats();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("withResponsesCompletionGrace", () => {
	it("throws the completion stall once every item is done and nothing follows within the grace", async () => {
		vi.useFakeTimers();
		const source = scriptedSource([added, done, "hang"]);
		const result = collect(withResponsesCompletionGrace(source.iterable, 1_000));
		await vi.advanceTimersByTimeAsync(999);
		await vi.advanceTimersByTimeAsync(1);
		const { types, error } = await result;
		expect(types).toEqual(["response.output_item.added", "response.output_item.done"]);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(formatResponsesCompletionStall(1_000));
	});

	it("keeps waiting without a deadline while an output item is still open", async () => {
		vi.useFakeTimers();
		const source = scriptedSource([added, "hang"]);
		let settled = false;
		const result = collect(withResponsesCompletionGrace(source.iterable, 1_000)).then((r) => {
			settled = true;
			return r;
		});
		await vi.advanceTimersByTimeAsync(RESPONSES_COMPLETION_GRACE_MS * 3);
		expect(settled).toBe(false);
		void result;
	});

	it("continues when a new item is added before the grace expires", async () => {
		vi.useFakeTimers();
		const source = scriptedSource([added, done, added, done, completed]);
		const { types, error } = await collect(withResponsesCompletionGrace(source.iterable, 1_000));
		expect(error).toBeUndefined();
		expect(types).toEqual([
			"response.output_item.added",
			"response.output_item.done",
			"response.output_item.added",
			"response.output_item.done",
			"response.completed",
		]);
	});

	it("does not arm before the first item is done", async () => {
		vi.useFakeTimers();
		const source = scriptedSource(["hang"]);
		let settled = false;
		const result = collect(withResponsesCompletionGrace(source.iterable, 1_000)).then((r) => {
			settled = true;
			return r;
		});
		await vi.advanceTimersByTimeAsync(RESPONSES_COMPLETION_GRACE_MS * 3);
		expect(settled).toBe(false);
		void result;
	});
});

describe("completion stall through the Codex SSE stream", () => {
	function mockToken(): string {
		const payload = Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_grace" } }),
			"utf8",
		).toString("base64");
		return `aaa.${payload}.bbb`;
	}

	const model: Model<"openai-codex-responses"> = {
		id: "gpt-5.6-sol",
		name: "GPT-5.6 Sol",
		api: "openai-codex-responses",
		provider: "chatgpt-subscription",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
	const context: Context = { systemPrompt: "", messages: [{ role: "user", content: "hi", timestamp: 1 }] };

	it("ends the turn as a retryable provider stall instead of waiting out the idle budget", async () => {
		vi.useFakeTimers();
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const events = [
					{ type: "response.created", response: { id: "resp_grace", status: "in_progress" } },
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
					},
					{
						type: "response.output_item.done",
						output_index: 0,
						item: {
							type: "message",
							id: "msg_1",
							role: "assistant",
							status: "completed",
							content: [{ type: "output_text", text: "done but never completed" }],
						},
					},
				];
				for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })),
		);

		const resultPromise = streamOpenAICodexResponses(model, context, {
			apiKey: mockToken(),
			transport: "sse",
			timeoutMs: 300_000,
		}).result();
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(RESPONSES_COMPLETION_GRACE_MS);
		const result = await resultPromise;

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(formatResponsesCompletionStall(RESPONSES_COMPLETION_GRACE_MS));
		expect(isProviderStreamStallError(result)).toBe(true);
		expect(isRetryableAssistantError(result)).toBe(true);
	});
});
