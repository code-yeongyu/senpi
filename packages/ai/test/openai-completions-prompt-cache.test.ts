import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Model } from "../src/types.ts";

interface FakeOpenAIClientOptions {
	apiKey: string;
	baseURL: string;
	dangerouslyAllowBrowser: boolean;
	defaultHeaders?: Record<string, string>;
}

interface CapturedCompletionsPayload {
	prompt_cache_key?: string;
	prompt_cache_retention?: "24h" | "in-memory" | null;
	session_id?: string;
}

const mockState = vi.hoisted(() => ({
	lastParams: undefined as CapturedCompletionsPayload | undefined,
	lastClientOptions: undefined as FakeOpenAIClientOptions | undefined,
	usage: undefined as
		| {
				prompt_tokens: number;
				completion_tokens: number;
				total_tokens?: number;
				cached_tokens?: number;
				prompt_tokens_details?: { cached_tokens?: number };
				completion_tokens_details?: { reasoning_tokens?: number };
		  }
		| undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedCompletionsPayload) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: mockState.usage ?? {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};

		constructor(options: FakeOpenAIClientOptions) {
			mockState.lastClientOptions = options;
		}
	}

	return { default: FakeOpenAI };
});

describe("openai-completions prompt caching", () => {
	const originalEnv = process.env.PI_CACHE_RETENTION;

	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.lastClientOptions = undefined;
		mockState.usage = undefined;
		delete process.env.PI_CACHE_RETENTION;
	});

	afterEach(() => {
		if (originalEnv === undefined) {
			delete process.env.PI_CACHE_RETENTION;
		} else {
			process.env.PI_CACHE_RETENTION = originalEnv;
		}
	});

	function createModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		return {
			...(baseModel as Omit<Model<"openai-completions">, "api">),
			api: "openai-completions",
			...overrides,
		};
	}

	async function captureRequest(
		options?: {
			cacheRetention?: "none" | "short" | "long";
			sessionId?: string;
			headers?: Record<string, string>;
		},
		model: Model<"openai-completions"> = createModel(),
	) {
		const message = await streamOpenAICompletions(
			model,
			{
				systemPrompt: "sys",
				messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
			},
			{ apiKey: "test-key", ...options },
		).result();

		return {
			payload: mockState.lastParams,
			headers: mockState.lastClientOptions?.defaultHeaders ?? {},
			message,
		};
	}

	it("parses flat cached_tokens from Kimi usage as cache-read tokens", async () => {
		mockState.usage = {
			prompt_tokens: 1000,
			completion_tokens: 10,
			total_tokens: 1010,
			cached_tokens: 400,
		};

		const { message } = await captureRequest();

		expect(message.usage.cacheRead).toBe(400);
		expect(message.usage.input).toBe(600);
	});

	it("sets a clamped prompt_cache_key for Moonshot requests with short retention", async () => {
		const sessionId = "moonshot-session-".repeat(5);
		const model = createModel({
			provider: "moonshotai",
			baseUrl: "https://api.moonshot.ai/v1",
		});

		const { payload } = await captureRequest({ cacheRetention: "short", sessionId }, model);

		expect(payload?.prompt_cache_key).toBe(sessionId.slice(0, 64));
	});

	it("does not set prompt_cache_key for unknown OpenAI-compatible providers", async () => {
		const model = createModel({
			provider: "custom",
			baseUrl: "https://proxy.example.com/v1",
		});

		const { payload } = await captureRequest({ cacheRetention: "short", sessionId: "custom-session" }, model);

		expect(payload?.prompt_cache_key).toBeUndefined();
	});

	it("sets prompt_cache_key for direct OpenAI requests when caching is enabled", async () => {
		const { payload } = await captureRequest({ sessionId: "session-123" });

		expect(payload?.prompt_cache_key).toBe("session-123");
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it("sets prompt_cache_retention to 24h for direct OpenAI requests when cacheRetention is long", async () => {
		const { payload } = await captureRequest({ cacheRetention: "long", sessionId: "session-456" });

		expect(payload?.prompt_cache_key).toBe("session-456");
		expect(payload?.prompt_cache_retention).toBe("24h");
	});

	it("clamps prompt_cache_key to OpenAI's 64-character limit", async () => {
		const sessionId = "x".repeat(67);
		const { payload } = await captureRequest({ sessionId });

		expect(payload?.prompt_cache_key).toBe("x".repeat(64));
	});

	it("omits prompt cache fields when cacheRetention is none", async () => {
		const { payload } = await captureRequest({ cacheRetention: "none", sessionId: "session-789" });

		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it("omits prompt cache fields for non-OpenAI base URLs without compatible long retention", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { supportsLongCacheRetention: false },
		});
		const { payload } = await captureRequest({ cacheRetention: "long", sessionId: "session-proxy" }, model);

		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(payload?.prompt_cache_retention).toBeUndefined();
	});

	it("uses PI_CACHE_RETENTION for direct OpenAI requests", async () => {
		process.env.PI_CACHE_RETENTION = "long";
		const { payload } = await captureRequest({ sessionId: "session-env" });

		expect(payload?.prompt_cache_key).toBe("session-env");
		expect(payload?.prompt_cache_retention).toBe("24h");
	});

	it("sends known session-affinity headers when compat.sendSessionAffinityHeaders is enabled", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { sendSessionAffinityHeaders: true },
		});
		const { headers } = await captureRequest({ sessionId: "session-affinity" }, model);

		expect(headers.session_id).toBe("session-affinity");
		expect(headers["x-client-request-id"]).toBe("session-affinity");
		expect(headers["x-session-affinity"]).toBe("session-affinity");
	});

	it("uses OpenAI no-session format when configured", async () => {
		const model = createModel({
			compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openai-nosession" },
		});
		const { payload, headers } = await captureRequest({ sessionId: "session-nosession" }, model);

		expect(payload?.session_id).toBeUndefined();
		expect(payload?.prompt_cache_key).toBe("session-nosession");
		expect(headers.session_id).toBeUndefined();
		expect(headers["x-client-request-id"]).toBe("session-nosession");
		expect(headers["x-session-affinity"]).toBe("session-nosession");
		expect(headers["x-session-id"]).toBeUndefined();
	});

	it("uses OpenRouter session-affinity header and body field when configured", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" },
		});
		const { payload, headers } = await captureRequest({ sessionId: "session-proxy" }, model);

		expect(payload?.session_id).toBe("session-proxy");
		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(headers["x-session-id"]).toBe("session-proxy");
		expect(headers.session_id).toBeUndefined();
		expect(headers["x-client-request-id"]).toBeUndefined();
		expect(headers["x-session-affinity"]).toBeUndefined();
	});

	it("auto-detects OpenRouter session-affinity header and body field for OpenRouter endpoints", async () => {
		const model = createModel({
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		});
		const { payload, headers } = await captureRequest({ sessionId: "session-openrouter" }, model);

		expect(payload?.session_id).toBe("session-openrouter");
		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(headers["x-session-id"]).toBe("session-openrouter");
		expect(headers.session_id).toBeUndefined();
		expect(headers["x-client-request-id"]).toBeUndefined();
		expect(headers["x-session-affinity"]).toBeUndefined();
	});

	it("omits OpenRouter session-affinity data when explicitly disabled", async () => {
		const model = createModel({
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			compat: { sendSessionAffinityHeaders: false },
		});
		const { payload, headers } = await captureRequest({ sessionId: "session-openrouter" }, model);

		expect(payload?.session_id).toBeUndefined();
		expect(payload?.prompt_cache_key).toBeUndefined();
		expect(headers["x-session-id"]).toBeUndefined();
	});

	it("omits session-affinity headers when cacheRetention is none", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { sendSessionAffinityHeaders: true },
		});
		const { headers } = await captureRequest({ cacheRetention: "none", sessionId: "session-affinity" }, model);

		expect(headers.session_id).toBeUndefined();
		expect(headers["x-client-request-id"]).toBeUndefined();
		expect(headers["x-session-affinity"]).toBeUndefined();
	});

	it("lets explicit headers override generated session-affinity headers", async () => {
		const model = createModel({
			baseUrl: "https://proxy.example.com/v1",
			compat: { sendSessionAffinityHeaders: true },
		});
		const { headers } = await captureRequest(
			{
				sessionId: "session-affinity",
				headers: {
					session_id: "override-session",
					"x-client-request-id": "override-request",
					"x-session-affinity": "override-affinity",
				},
			},
			model,
		);

		expect(headers.session_id).toBe("override-session");
		expect(headers["x-client-request-id"]).toBe("override-request");
		expect(headers["x-session-affinity"]).toBe("override-affinity");
	});
});
