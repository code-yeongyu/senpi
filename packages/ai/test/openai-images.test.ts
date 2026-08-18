import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openaiImagesApi } from "../src/api/openai-images.lazy.ts";
import { generateImages, type OpenAIImagesOptions } from "../src/api/openai-images.ts";
import type { ImagesContext, ImagesModel } from "../src/types.ts";

const PNG_B64 = "iVBORw0KGgo=";
const WEBP_B64 = "UklGRgAAAABXRUJQ";
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;
const mockState = vi.hoisted(() => ({
	clientOptions: [] as unknown[],
	requestParams: [] as unknown[],
	requestOptions: [] as unknown[],
	requestErrors: [] as Error[],
	responses: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		constructor(options: unknown) {
			mockState.clientOptions.push(options);
		}

		images = {
			generate: (params: unknown, options?: unknown) => {
				mockState.requestParams.push(params);
				mockState.requestOptions.push(options);
				return {
					withResponse: async () => {
						const error = mockState.requestErrors.shift();
						if (error) throw error;
						return {
							data: mockState.responses[0],
							response: { status: 201, headers: new Headers({ "x-request-id": "req-1" }) },
						};
					},
				};
			},
		};
	}
	return { default: FakeOpenAI };
});

type ImageFixture = { b64_json?: string; url?: string; revised_prompt?: string };
type UsageFixture = { input_tokens: number; output_tokens: number; total_tokens?: number };

function setResponse(data: ImageFixture[] | null = [{ b64_json: PNG_B64 }], usage?: UsageFixture): void {
	mockState.responses[0] = { created: 1, ...(data === null ? {} : { data }), ...(usage ? { usage } : {}) };
}

const model: ImagesModel<"openai-images"> = {
	id: "gpt-image-2",
	name: "GPT Image 2",
	api: "openai-images",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	input: ["text"],
	output: ["image"],
	cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
};
const context: ImagesContext = { input: [{ type: "text", text: "Draw a lighthouse" }] };

function run(options: OpenAIImagesOptions = {}, target = model, input = context) {
	return generateImages(target, input, { apiKey: "test-key", ...options });
}

function providerError(message: string, status: number): Error {
	return Object.assign(new Error(message), { status, headers: new Headers({ "retry-after-ms": "100" }) });
}

describe("openai images", () => {
	beforeEach(() => {
		for (const values of [
			mockState.clientOptions,
			mockState.requestParams,
			mockState.requestOptions,
			mockState.requestErrors,
		]) {
			values.length = 0;
		}
		setResponse();
	});
	afterEach(() => vi.useRealTimers());

	it("sends the exact default body to the canonical endpoint", async () => {
		const result = await run();
		expect(result.stopReason).toBe("stop");
		expect(mockState.clientOptions[0]).toMatchObject({ baseURL: "https://api.openai.com/v1" });
		expect(mockState.requestParams[0]).toEqual({
			model: "gpt-image-2",
			prompt: "Draw a lighthouse",
			size: "auto",
			quality: "auto",
			n: 1,
			output_format: "png",
			stream: false,
		});
		expect(mockState.requestParams[0]).not.toHaveProperty("response_format");
		expect(mockState.requestOptions[0]).toMatchObject({ maxRetries: 0 });
	});

	it.each([
		["https://api.openai.com", "https://api.openai.com/v1"],
		["https://api.openai.com/", "https://api.openai.com/v1"],
		["https://api.openai.com/v1/", "https://api.openai.com/v1"],
		["https://gateway.test/openai", "https://gateway.test/openai/v1"],
		["https://gateway.test/openai/v1", "https://gateway.test/openai/v1"],
	])("normalizes base URL %s without duplicating v1", async (baseUrl, expected) => {
		await run({}, { ...model, baseUrl });
		expect(mockState.clientOptions[0]).toMatchObject({ baseURL: expected });
	});

	it.each([
		"https://api.openai.com/v1?route=images",
		"https://api.openai.com/v1#images",
		"https://api.openai.com/v1/images/generations",
		"https://api.openai.com/v1/chat/completions",
		"https://api.openai.com/v1/responses",
		"https://api.openai.com/v1/models",
	])("rejects malformed endpoint base URL %s", async (baseUrl) => {
		expect((await run({}, { ...model, baseUrl })).stopReason).toBe("error");
		expect(mockState.requestParams).toHaveLength(0);
	});

	it("sanitizes and joins multiple text blocks", async () => {
		const input: ImagesContext = {
			input: [
				{ type: "text", text: "First" },
				{ type: "text", text: "Sec\uD800ond" },
			],
		};
		await run({}, model, input);
		expect(mockState.requestParams[0]).toMatchObject({ prompt: "First\n\nSecond" });
	});

	it("rejects invalid inputs before fetch", async () => {
		const invalid: Array<[ImagesContext, string]> = [
			[{ input: [] }, "non-empty"],
			[{ input: [{ type: "text", text: "   " }] }, "non-empty"],
			[{ input: [{ type: "text", text: "x".repeat(32001) }] }, "32000"],
			[{ input: [{ type: "image", mimeType: "image/png", data: PNG_B64 }] }, "images edit endpoint"],
		];
		for (const [input, message] of invalid) {
			expect((await run({}, model, input)).errorMessage).toContain(message);
		}
		expect(mockState.requestParams).toHaveLength(0);
	});

	it("runs payload and response hooks", async () => {
		const onResponse = vi.fn();
		await run({ onPayload: () => ({ model: "hooked", prompt: "Hooked" }), onResponse });
		expect(mockState.requestParams[0]).toEqual({ model: "hooked", prompt: "Hooked" });
		expect(onResponse).toHaveBeenCalledWith(
			{ status: 201, headers: { "x-request-id": "req-1" } },
			expect.objectContaining({ id: "gpt-image-2" }),
		);
	});

	it("merges headers, resolves credential-header auth, and envelopes missing auth lazily", async () => {
		const target = { ...model, headers: { "x-order": "model", "x-remove": "model" } };
		await generateImages(target, context, {
			headers: { "x-order": "option", "x-remove": null, "api-key": "credential" },
		});
		expect(mockState.clientOptions[0]).toMatchObject({
			apiKey: "unused",
			defaultHeaders: { Authorization: null, "x-order": "option", "x-remove": null, "api-key": "credential" },
		});
		expect(await generateImages(model, context)).toMatchObject({
			stopReason: "error",
			errorMessage: "No API key for provider: openai",
		});
		expect(await openaiImagesApi().generateImages(model, context)).toMatchObject({ stopReason: "error", output: [] });
	});

	it("orders revised prompts, parses data URLs, prefers b64, and tolerates count mismatch", async () => {
		setResponse([
			{ b64_json: PNG_B64, revised_prompt: "Refined lighthouse" },
			{ url: `data:image/webp;base64,${WEBP_B64}` },
			{ b64_json: PNG_B64, url: `data:image/webp;base64,${WEBP_B64}` },
		]);
		const result = await run({ n: 4 });
		expect(result.stopReason).toBe("stop");
		expect(result.output).toEqual([
			{ type: "text", text: "Refined lighthouse" },
			{ type: "image", mimeType: "image/png", data: PNG_B64 },
			{ type: "image", mimeType: "image/webp", data: WEBP_B64 },
			{ type: "image", mimeType: "image/png", data: PNG_B64 },
		]);
	});

	it("hydrates signed URLs without auth leakage and accepts magic-byte MIME", async () => {
		setResponse([{ url: "https://signed.test/image" }]);
		const signal = new AbortController().signal;
		const fetchImage = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]), {
					headers: { "content-type": "application/octet-stream" },
				}),
		);
		const result = await run({ fetch: fetchImage, signal, headers: { Authorization: "Bearer fake-header" } });
		expect(result.output[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
		expect(fetchImage).toHaveBeenCalledWith("https://signed.test/image", { signal });
	});

	it("rejects empty, failed, invalid, mismatched, and oversized hydration", async () => {
		for (const data of [null, []]) {
			setResponse(data);
			expect((await run()).stopReason).toBe("error");
		}
		const failures: Array<[typeof globalThis.fetch, string]> = [
			[async () => new Response(null, { status: 401 }), "HTTP 401"],
			[async () => new Response(null, { headers: { "content-type": "image/png" } }), "empty body"],
			[async () => new Response("nope", { headers: { "content-type": "text/plain" } }), "unsupported"],
			[
				async () => new Response(Uint8Array.from([0xff, 0xd8, 0xff]), { headers: { "content-type": "image/png" } }),
				"mismatch",
			],
			[async () => new Response(PNG_B64, { headers: { "content-length": String(MAX_IMAGE_BYTES + 1) } }), "24 MiB"],
		];
		for (const [fetch, message] of failures) {
			setResponse([{ url: "https://signed.test/image" }]);
			expect((await run({ fetch })).errorMessage).toContain(message);
		}
	});

	it("classifies aborts and normalizes provider error bodies", async () => {
		const controller = new AbortController();
		controller.abort();
		mockState.requestErrors.push(new Error("ignored"));
		expect(await run({ signal: controller.signal })).toMatchObject({
			stopReason: "aborted",
			errorMessage: "Request aborted",
		});
		mockState.requestErrors.push(
			Object.assign(new Error("opaque"), { status: 401, error: { message: "invalid credential" } }),
		);
		expect(await run()).toMatchObject({ stopReason: "error", errorMessage: '401: {"message":"invalid credential"}' });
	});

	it("defaults to no retry and supports opt-in retry with fake timers", async () => {
		mockState.requestErrors.push(providerError("rate limited", 429));
		expect((await run()).stopReason).toBe("error");
		expect(mockState.requestParams).toHaveLength(1);
		mockState.requestParams.length = 0;
		mockState.requestErrors.push(providerError("rate limited", 429));
		vi.useFakeTimers();
		const retried = run({ maxRetries: 1, maxRetryDelayMs: 100 });
		await vi.advanceTimersByTimeAsync(99);
		expect(mockState.requestParams).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect((await retried).stopReason).toBe("stop");
		expect(mockState.requestParams).toHaveLength(2);
	});

	it("maps usage and per-million costs", async () => {
		setResponse(undefined, { input_tokens: 10, output_tokens: 20 });
		const usage = (await run()).usage;
		expect(usage).toMatchObject({ input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30 });
		expect(usage?.cost.input).toBeCloseTo(0.00002);
		expect(usage?.cost.output).toBeCloseTo(0.00008);
		expect(usage?.cost.total).toBeCloseTo(0.0001);
	});
});
