import { describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { AssistantMessageEvent, Context, Model } from "../src/types.ts";

const INPUT_TOKENS = 210_744;
const SERVER_WINDOW = 294_912;
const OUTPUT_TOKENS = 131_072;
const SAFE_OUTPUT = 80_072;
const context: Context = {
	messages: [{ role: "user", content: "abcd".repeat(INPUT_TOKENS), timestamp: 1 }],
};

function model(contextWindow = 1_048_576): Model<"openai-completions"> {
	return {
		id: "moonshotai/kimi-k3-ultrafast",
		name: "Kimi fixture",
		api: "openai-completions",
		provider: "og",
		baseUrl: "https://mock.invalid/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: OUTPUT_TOKENS,
		compat: { maxTokensField: "max_tokens", supportsReasoningEffort: true },
	};
}

function rejection(input: number, completion: number): string {
	return `Prefill server error (400 Bad Request): ${JSON.stringify({
		object: "error",
		message: `Requested token count exceeds the model's maximum context length of ${SERVER_WINDOW} tokens. You requested a total of ${input + completion} tokens: ${input} tokens from the input messages and ${completion} tokens for the completion. Please reduce the number of tokens in the input messages or the completion to fit within the limit.`,
		type: "BadRequestError",
		param: null,
		code: 400,
	})}`;
}

function record(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
	return Object.fromEntries(Object.entries(value));
}

function provider(
	options: { input?: number; alwaysReject?: boolean; partial?: boolean; error?: string; onRequest?: () => void } = {},
) {
	const requests: Record<string, unknown>[] = [];
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		if (typeof init?.body !== "string") throw new Error("Expected serialized request body");
		const body = record(JSON.parse(init.body));
		requests.push(body);
		const completion = body.max_tokens ?? body.max_completion_tokens;
		if (typeof completion !== "number") throw new Error("Expected completion cap");
		const input = options.input ?? INPUT_TOKENS;
		const data =
			options.alwaysReject || input + completion > SERVER_WINDOW
				? { error: { message: options.error ?? rejection(input, completion), type: "BadRequestError", code: 400 } }
				: {
						id: "budget-fixture",
						choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
						usage: { prompt_tokens: INPUT_TOKENS, completion_tokens: 1, total_tokens: INPUT_TOKENS + 1 },
					};
		const partial = options.partial
			? `data: ${JSON.stringify({ id: "partial", choices: [{ index: 0, delta: { content: "partial" } }] })}\n\n`
			: "";
		options.onRequest?.();
		return new Response(`${partial}data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	};
	return { requests, fetch };
}

describe("OpenAI-compatible prefill output budget", () => {
	it("repairs the incident budget once when custom target metadata overstates the window", async () => {
		// Given: the fallback target declares 1M, but prefill enforces 294912.
		const remote = provider();
		const events: AssistantMessageEvent[] = [];
		// When: the real simple-stream adapter builds and sends the request.
		const result = streamSimple(model(), context, {
			apiKey: "fixture",
			fetch: remote.fetch,
			maxRetries: 0,
			reasoning: "high",
		});
		for await (const event of result) events.push(event);
		const response = await result.result();
		// Then: only the completion reservation changes, with a single exposed stream.
		expect(response.stopReason, response.errorMessage).toBe("stop");
		expect(remote.requests.map((request) => request.max_tokens)).toEqual([OUTPUT_TOKENS, SAFE_OUTPUT]);
		expect(remote.requests[1]).toEqual({ ...remote.requests[0], max_tokens: SAFE_OUTPUT });
		expect(events.filter((event) => event.type === "start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "error")).toHaveLength(0);
	});

	it("needs no repair when target metadata already gives the server window", async () => {
		// Given: accurate target metadata.
		const remote = provider();
		// When: the existing admission clamp runs.
		const response = await streamSimple(model(SERVER_WINDOW), context, {
			apiKey: "fixture",
			fetch: remote.fetch,
			maxRetries: 0,
		}).result();
		// Then: one safe request succeeds without a prefill rejection.
		expect(response.stopReason).toBe("stop");
		expect(remote.requests.map((request) => request.max_tokens)).toEqual([SAFE_OUTPUT]);
	});

	it.each([4096, 100_000])(
		"preserves an explicit %i cap unless the reported window requires less",
		async (maxTokens) => {
			// Given: a caller-specified output cap, distinct from the model default.
			const remote = provider();
			// When: the provider enforces its actual window.
			const response = await streamSimple(model(), context, {
				apiKey: "fixture",
				fetch: remote.fetch,
				maxRetries: 0,
				maxTokens,
			}).result();
			// Then: fitting caps are untouched; overflowing caps use the reported room.
			expect(response.stopReason).toBe("stop");
			expect(remote.requests.map((request) => request.max_tokens)).toEqual(
				maxTokens > SAFE_OUTPUT ? [maxTokens, SAFE_OUTPUT] : [maxTokens],
			);
		},
	);

	it("uses the actual post-hook wire cap and does not run the payload hook twice", async () => {
		// Given: a hook replaces the computed cap and adds an unrelated field.
		const remote = provider();
		const onPayload = vi.fn((payload: unknown) => ({ ...record(payload), max_tokens: 100_000, seed: 7 }));
		// When: that wire request is rejected.
		const response = await streamSimple(model(), context, {
			apiKey: "fixture",
			fetch: remote.fetch,
			maxRetries: 0,
			onPayload,
		}).result();
		// Then: repair retains the exact payload other than its completion cap.
		expect(response.stopReason).toBe("stop");
		expect(onPayload).toHaveBeenCalledTimes(1);
		expect(remote.requests[0]?.max_tokens).toBe(100_000);
		expect(remote.requests[1]).toEqual({ ...remote.requests[0], max_tokens: SAFE_OUTPUT });
	});

	it("preserves the max_completion_tokens wire variant", async () => {
		// Given: the other supported output field.
		const target = model();
		target.compat = { ...target.compat, maxTokensField: "max_completion_tokens" };
		const remote = provider();
		// When: prefill rejects its budget.
		const response = await streamSimple(target, context, {
			apiKey: "fixture",
			fetch: remote.fetch,
			maxRetries: 0,
		}).result();
		// Then: the same field is corrected without adding max_tokens.
		expect(response.stopReason).toBe("stop");
		expect(remote.requests[1]).toEqual({ ...remote.requests[0], max_completion_tokens: SAFE_OUTPUT });
		expect(remote.requests[1]?.max_tokens).toBeUndefined();
	});

	it.each([
		{ name: "input itself exhausts the window", remote: { input: SERVER_WINDOW }, thinkingBudgets: undefined },
		{ name: "explicit reasoning would lose room", remote: {}, thinkingBudgets: { high: 90_000 } },
		{
			name: "reported cap differs from the wire",
			remote: { error: rejection(INPUT_TOKENS, 130_000) },
			thinkingBudgets: undefined,
		},
		{
			name: "error lacks complete budget evidence",
			remote: { error: "context_length_exceeded" },
			thinkingBudgets: undefined,
		},
	])("leaves normal error handling in charge when $name", async ({ remote: config, thinkingBudgets }) => {
		// Given: reducing the output cannot safely satisfy the proven contract.
		const remote = provider(config);
		// When: the first prefill fails.
		const response = await streamSimple(model(), context, {
			apiKey: "fixture",
			fetch: remote.fetch,
			maxRetries: 0,
			reasoning: "high",
			thinkingBudgets,
		}).result();
		// Then: no new send or reasoning downgrade is attempted.
		expect(response.stopReason).toBe("error");
		expect(remote.requests).toHaveLength(1);
	});

	it("propagates a second rejection without another budget repair", async () => {
		// Given: the server continues rejecting after the evidenced correction.
		const remote = provider({ alwaysReject: true });
		// When: one correction is attempted.
		const response = await streamSimple(model(), context, {
			apiKey: "fixture",
			fetch: remote.fetch,
			maxRetries: 0,
		}).result();
		// Then: bounded failure remains available to session overflow recovery.
		expect(response.stopReason).toBe("error");
		expect(remote.requests.map((request) => request.max_tokens)).toEqual([OUTPUT_TOKENS, SAFE_OUTPUT]);
	});

	it("never replays a response after the first chunk", async () => {
		// Given: visible content precedes an otherwise matching error.
		const remote = provider({ partial: true });
		// When: the stream fails after content.
		const response = await streamSimple(model(), context, {
			apiKey: "fixture",
			fetch: remote.fetch,
			maxRetries: 0,
		}).result();
		// Then: the partial response is retained without a duplicate request.
		expect(response.stopReason).toBe("error");
		expect(response.content).toEqual([{ type: "text", text: "partial" }]);
		expect(remote.requests).toHaveLength(1);
	});

	it("does not repair after cancellation at the request boundary", async () => {
		// Given: cancellation is signalled by the exact first-request event.
		const controller = new AbortController();
		const remote = provider({ onRequest: () => controller.abort() });
		// When: the first request is aborted.
		const response = await streamSimple(model(), context, {
			apiKey: "fixture",
			fetch: remote.fetch,
			maxRetries: 0,
			signal: controller.signal,
		}).result();
		// Then: no correction is sent.
		expect(response.stopReason).toBe("aborted");
		expect(remote.requests).toHaveLength(1);
	});
});
