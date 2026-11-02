import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

type StreamBehavior =
	| { readonly kind: "success"; readonly text?: string }
	| { readonly kind: "error"; readonly error: Error; readonly afterChunks: 0 | 1 };

const mockState = vi.hoisted(() => ({
	requestOptions: [] as unknown[],
	requestErrors: [] as Error[],
	streamBehaviors: [] as StreamBehavior[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (_params: unknown, options: unknown) => {
					mockState.requestOptions.push(options);
					const behavior = mockState.streamBehaviors.shift();
					const stream = {
						async *[Symbol.asyncIterator]() {
							if (behavior?.kind === "error" && behavior.afterChunks === 0) {
								throw behavior.error;
							}
							yield {
								id: "chatcmpl-test",
								choices: [
									{
										index: 0,
										delta: { content: behavior?.kind === "success" ? (behavior.text ?? "ok") : "ok" },
									},
								],
							};
							if (behavior?.kind === "error" && behavior.afterChunks === 1) {
								throw behavior.error;
							}
							yield {
								id: "chatcmpl-test",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => {
						const error = mockState.requestErrors.shift();
						if (error) throw error;
						return {
							data: stream,
							response: { status: 200, headers: new Headers() },
						};
					};
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const model: Model<"openai-completions"> = {
	id: "test-model",
	name: "Test Model",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

const context = normalizeContext({
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
});

async function consume(options?: { maxRetries?: number; maxRetryDelayMs?: number }) {
	const stream = streamOpenAICompletions(model, context, { apiKey: "test", ...options });
	for await (const _event of stream) {
		void _event;
	}
	return stream.result();
}

describe("openai-completions provider retries", () => {
	beforeEach(() => {
		mockState.requestOptions = [];
		mockState.requestErrors = [];
		mockState.streamBehaviors = [];
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("disables SDK retries by default", async () => {
		await consume();
		expect(mockState.requestOptions).toEqual([expect.objectContaining({ maxRetries: 0 })]);
	});

	it("honors provider retries while keeping SDK retries disabled", async () => {
		vi.useFakeTimers();
		mockState.requestErrors = [
			Object.assign(new Error("rate limited"), {
				status: 429,
				headers: new Headers({ "retry-after-ms": "100" }),
			}),
			Object.assign(new Error("server error"), {
				status: 500,
				headers: new Headers({ "retry-after-ms": "100" }),
			}),
		];

		const result = consume({ maxRetries: 2, maxRetryDelayMs: 100 });
		await vi.advanceTimersByTimeAsync(0);
		expect(mockState.requestOptions).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(99);
		expect(mockState.requestOptions).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(mockState.requestOptions).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(99);
		expect(mockState.requestOptions).toHaveLength(2);
		await vi.advanceTimersByTimeAsync(1);
		await result;

		expect(mockState.requestOptions).toEqual([
			expect.objectContaining({ maxRetries: 0 }),
			expect.objectContaining({ maxRetries: 0 }),
			expect.objectContaining({ maxRetries: 0 }),
		]);
	});

	it("fails immediately when a provider-requested retry delay exceeds the limit", async () => {
		mockState.requestErrors = [
			Object.assign(new Error("rate limited"), {
				status: 429,
				headers: new Headers({ "retry-after": "277403" }),
			}),
		];

		const result = await consume({ maxRetries: 2, maxRetryDelayMs: 1000 });

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Server requested 277403s retry delay (max: 1s)");
		expect(result.errorMessage).toContain("rate limited");
		expect(mockState.requestOptions).toEqual([expect.objectContaining({ maxRetries: 0 })]);
	});

	it("retries the observed DigitalOcean failure before the first stream chunk", async () => {
		vi.useFakeTimers();
		mockState.streamBehaviors = [
			{
				kind: "error",
				afterChunks: 0,
				error: new Error("Upstream error from DigitalOcean: stream failed"),
			},
			{ kind: "success", text: "recovered" },
		];

		const result = consume({ maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(500);
		const message = await result;

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(mockState.requestOptions).toHaveLength(2);
	});

	it("bounds retries for repeated pre-chunk stream failures", async () => {
		vi.useFakeTimers();
		const streamFailure = () => new Error("Upstream error from DigitalOcean: stream failed");
		mockState.streamBehaviors = [
			{ kind: "error", afterChunks: 0, error: streamFailure() },
			{ kind: "error", afterChunks: 0, error: streamFailure() },
		];

		const result = consume({ maxRetries: 1 });
		await vi.advanceTimersByTimeAsync(500);
		const message = await result;

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Upstream error from DigitalOcean: stream failed");
		expect(mockState.requestOptions).toHaveLength(2);
	});

	it("does not retry non-retryable pre-chunk stream failures", async () => {
		mockState.streamBehaviors = [
			{
				kind: "error",
				afterChunks: 0,
				error: Object.assign(new Error("invalid request"), {
					status: 400,
					headers: new Headers(),
				}),
			},
		];

		const message = await consume({ maxRetries: 2, maxRetryDelayMs: 100 });

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("invalid request");
		expect(mockState.requestOptions).toHaveLength(1);
	});

	it("does not retry after the first stream chunk", async () => {
		mockState.streamBehaviors = [
			{
				kind: "error",
				afterChunks: 1,
				error: new Error("Upstream error from DigitalOcean: stream failed"),
			},
			{ kind: "success", text: "duplicate" },
		];

		const message = await consume({ maxRetries: 2, maxRetryDelayMs: 100 });

		expect(message.stopReason).toBe("error");
		expect(message.content).toEqual([{ type: "text", text: "ok" }]);
		expect(mockState.requestOptions).toHaveLength(1);
	});
});
