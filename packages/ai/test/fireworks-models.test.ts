import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, getModels, normalizeContext, streamSimple } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Context, Model, Tool } from "../src/types.ts";
import { fireworksCompletionsModels, fireworksMessagesModels, firstModel, requireModels } from "./fireworks-catalog.ts";

const messagesModels = requireModels(fireworksMessagesModels(), 2);
const completionsModels = requireModels(fireworksCompletionsModels(), 1);
const adaptiveMessagesModels = requireModels(
	messagesModels.filter((model) => model.compat?.forceAdaptiveThinking === true),
	1,
);
const toggleOnlyMessagesModel = firstModel(
	messagesModels.filter((model) => model.compat?.forceAdaptiveThinking === undefined),
);
const glmModels = requireModels(
	completionsModels.filter((model) => model.id.includes("glm-5p2") || model.id.includes("glm-5p3")),
	1,
);
const kimiK3Models = requireModels(
	completionsModels.filter((model) => model.id.includes("kimi-k3")),
	1,
);
const fastRouterPairs = completionsModels.flatMap((fast) => {
	const match = /^accounts\/fireworks\/routers\/(.+)-fast$/.exec(fast.id);
	const base = match && completionsModels.find((model) => model.id === `accounts/fireworks/models/${match[1]}`);
	return base ? [[fast.id, base, fast] as const] : [];
});

const originalFireworksApiKey = process.env.FIREWORKS_API_KEY;

afterEach(() => {
	if (originalFireworksApiKey === undefined) {
		delete process.env.FIREWORKS_API_KEY;
	} else {
		process.env.FIREWORKS_API_KEY = originalFireworksApiKey;
	}
});

describe("Fireworks models", () => {
	it("enables native tool references only on Messages models", () => {
		for (const model of getModels("fireworks")) {
			if (model.api === "anthropic-messages") {
				expect(model.compat).toMatchObject({ supportsToolReferences: true });
			} else {
				expect(model.compat).not.toHaveProperty("supportsToolReferences");
			}
		}
	});

	it("serves Messages models from the Anthropic-compatible endpoint and the rest from /v1", () => {
		for (const model of messagesModels) {
			expect(model.provider).toBe("fireworks");
			expect(model.baseUrl).toBe("https://api.fireworks.ai/inference");
		}
		for (const model of completionsModels) {
			expect(model.provider).toBe("fireworks");
			expect(model.baseUrl).toBe("https://api.fireworks.ai/inference/v1");
		}
	});

	it("registers the Fire Pass fast router model", () => {
		const model = getModels("fireworks").find(
			(candidate) => candidate.id === "accounts/fireworks/routers/kimi-k3-fast",
		);

		expect(model).toBeDefined();
		expect(model?.api).toBe("openai-completions");
		expect(model?.baseUrl).toBe("https://api.fireworks.ai/inference/v1");
		expect(model?.input).toEqual(["text", "image"]);
	});

	it("catalogs at least one fast router next to its base model", () => {
		expect(fastRouterPairs.length).toBeGreaterThan(0);
	});

	it.each(fastRouterPairs)("aligns %s with its base model's OpenAI-compatible config", (_id, base, fast) => {
		expect(fast.api).toBe(base.api);
		expect(fast.baseUrl).toBe(base.baseUrl);
		expect(fast.compat).toEqual(base.compat);
		expect(fast.thinkingLevelMap).toEqual(base.thinkingLevelMap);
	});

	it.each(glmModels.map((model) => [model.id, model] as const))(
		"omits unsupported long cache retention for %s",
		async (_id, model) => {
			let payload: Record<string, unknown> | undefined;
			const response = streamSimple(
				model,
				{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
				{
					apiKey: "test-fireworks-key",
					cacheRetention: "long",
					sessionId: "test-fireworks-session",
					onPayload: (value) => {
						payload = value as Record<string, unknown>;
						throw new Error("payload captured");
					},
				},
			);
			await response.result();

			expect(payload).toBeDefined();
			expect(payload?.prompt_cache_retention).toBeUndefined();
		},
	);

	it("routes Kimi K3 through the OpenAI-compatible API with native effort controls", async () => {
		const base = getModel("fireworks", "accounts/fireworks/models/kimi-k3");
		const fast = getModel("fireworks", "accounts/fireworks/routers/kimi-k3-fast");
		const compat = {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsStrictMode: true,
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "openai",
			supportsMidConvoSystemMessages: true,
			supportsMidConvoToolAdditions: true,
			sendSessionAffinityHeaders: true,
			supportsLongCacheRetention: false,
		};
		const thinkingLevelMap = {
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		};

		expect(base.api).toBe("openai-completions");
		expect(base.baseUrl).toBe("https://api.fireworks.ai/inference/v1");
		expect(base.compat).toEqual(compat);
		expect(base.thinkingLevelMap).toEqual(thinkingLevelMap);
		expect(fast.api).toBe(base.api);
		expect(fast.baseUrl).toBe(base.baseUrl);
		expect(fast.compat).toEqual(compat);
		expect(fast.thinkingLevelMap).toEqual(thinkingLevelMap);

		let payload: Record<string, unknown> | undefined;
		const response = streamSimple(
			base,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-fireworks-key",
				reasoning: "max",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		);
		await response.result();

		expect(payload?.reasoning_effort).toBe("max");
	});

	// Regression for #9323: native effort must reach Messages without budget-based fallback.
	it.each(adaptiveMessagesModels.map((model) => [model.id, model] as const))(
		"sends native Messages effort levels for %s",
		async (_id, model) => {
			const levels = getSupportedThinkingLevels(model);
			expect(levels.length).toBeGreaterThan(0);

			for (const level of levels) {
				let payload: Record<string, unknown> | undefined;
				await streamSimple(
					model,
					{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
					{
						apiKey: "test-fireworks-key",
						reasoning: level === "off" ? undefined : level,
						onPayload: (value) => {
							payload = value as Record<string, unknown>;
							throw new Error("payload captured");
						},
					},
				).result();
				expect(payload).toBeDefined();
				expect(payload?.thinking).toEqual(
					level === "off" ? { type: "disabled" } : { type: "adaptive", display: "summarized" },
				);
				expect(payload?.output_config).toEqual(level === "off" ? undefined : { effort: level });
			}
		},
	);

	// Regression for #9323: accepted aliases are not distinct native effort levels.
	it.each([
		...glmModels.map((model) => [model.id, model, ["off", "high", "max"]] as const),
		...kimiK3Models.map((model) => [model.id, model, ["low", "high", "max"]] as const),
	])("exposes distinct native effort levels for %s", (_id, model, levels) => {
		expect(getSupportedThinkingLevels(model)).toEqual(levels);
	});

	it("keeps toggle-only Messages models without a verified fallback on budget-based thinking", async () => {
		const model = toggleOnlyMessagesModel;
		expect(model.compat?.forceAdaptiveThinking).toBeUndefined();
		let payload: Record<string, unknown> | undefined;
		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-fireworks-key",
				reasoning: "high",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();
		expect(payload?.thinking).toEqual({ type: "enabled", budget_tokens: 16384, display: "summarized" });
		expect(payload?.output_config).toBeUndefined();
	});

	it("resolves FIREWORKS_API_KEY from the environment", () => {
		process.env.FIREWORKS_API_KEY = "test-fireworks-key";

		expect(findEnvKeys("fireworks")).toEqual(["FIREWORKS_API_KEY"]);
		expect(getEnvApiKey("fireworks")).toBe("test-fireworks-key");
	});

	it("sets Fireworks-specific compat for session affinity and unsupported tool fields", () => {
		for (const model of messagesModels) {
			expect(model.compat).toBeDefined();
			expect(model.compat?.sendSessionAffinityHeaders).toBe(true);
			expect(model.compat?.supportsEagerToolInputStreaming).toBe(false);
			expect(model.compat?.supportsCacheControlOnTools).toBe(false);
			expect(model.compat?.supportsLongCacheRetention).toBe(false);
			expect(model.compat?.allowEmptySignature).toBe(true);
			expect(model.compat?.supportsToolReferences).toBe(true);
		}
	});
});

// --- Integration tests for Fireworks Anthropic session affinity and tool compat ---

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

const tool: Tool = {
	name: "lookup",
	description: "Look up a value",
	parameters: Type.Object({ value: Type.String() }),
};

const FIREWORKS_ANTHROPIC_COMPAT = {
	allowEmptySignature: true,
	sendSessionAffinityHeaders: true,
	supportsEagerToolInputStreaming: false,
	supportsCacheControlOnTools: false,
	supportsLongCacheRetention: false,
} satisfies NonNullable<Model<"anthropic-messages">["compat"]>;

function createFireworksModel(
	compat: Model<"anthropic-messages">["compat"] = FIREWORKS_ANTHROPIC_COMPAT,
): Model<"anthropic-messages"> {
	return {
		id: "accounts/fireworks/models/kimi-k2p6",
		name: "Kimi K2.6",
		api: "anthropic-messages",
		provider: "fireworks",
		baseUrl: "http://127.0.0.1:0", // overridden by captureAnthropicRequest
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
		contextWindow: 262000,
		maxTokens: 262000,
		compat,
	};
}

function createAnthropicModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "http://127.0.0.1:0", // overridden by captureAnthropicRequest
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	};
}

function createOpenRouterModel(): Model<"anthropic-messages"> {
	return {
		...createAnthropicModel(),
		id: "anthropic/claude-opus-4.8",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api",
	};
}

function createContext(tools: Tool[] = [tool]): Context {
	return {
		messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
		...(tools.length > 0 ? { tools } : {}),
	};
}

async function readRequestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function writeEmptySseResponse(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end();
}

async function captureAnthropicRequest(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: { sessionId?: string; cacheRetention?: string },
): Promise<CapturedRequest> {
	let capturedRequest: CapturedRequest | undefined;

	const server = createServer(async (request, response) => {
		capturedRequest = {
			headers: request.headers,
			body: await readRequestBody(request),
		};
		writeEmptySseResponse(response);
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;

	try {
		// Override the model's baseUrl to point to the local test server
		const localModel = { ...model, baseUrl: `http://127.0.0.1:${address.port}` };

		const stream = streamAnthropic(localModel, normalizeContext(context), {
			apiKey: "test-key",
			cacheRetention: (options?.cacheRetention as "none" | "short" | "long") ?? "short",
			sessionId: options?.sessionId,
		});

		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	if (!capturedRequest) {
		throw new Error("Anthropic request was not captured");
	}
	return capturedRequest;
}

function getTools(body: Record<string, unknown>): Record<string, unknown>[] {
	const tools = body.tools;
	if (!Array.isArray(tools)) {
		throw new Error("Expected tools in request body");
	}
	return tools as Record<string, unknown>[];
}

describe("Anthropic-compatible session affinity and tool compat", () => {
	it("sends x-session-affinity header for Fireworks models", async () => {
		const model = createFireworksModel();
		// Need a real port, capture will assign one
		const request = await captureAnthropicRequest(model, createContext(), {
			sessionId: "fireworks-session-1",
		});

		expect(request.headers["x-session-affinity"]).toBe("fireworks-session-1");
	});

	it("omits x-session-affinity header for native Anthropic models", async () => {
		const model = createAnthropicModel();
		const request = await captureAnthropicRequest(model, createContext(), {
			sessionId: "anthropic-session-1",
		});

		expect(request.headers["x-session-affinity"]).toBeUndefined();
	});

	it("omits x-session-affinity header when cacheRetention is none", async () => {
		const model = createFireworksModel();
		const request = await captureAnthropicRequest(model, createContext(), {
			sessionId: "fireworks-session-2",
			cacheRetention: "none",
		});

		expect(request.headers["x-session-affinity"]).toBeUndefined();
	});

	// Regression test for https://github.com/earendil-works/pi/issues/9102
	it("sends only x-session-id for OpenRouter models", async () => {
		const request = await captureAnthropicRequest(createOpenRouterModel(), createContext(), {
			sessionId: "openrouter-session-1",
		});

		expect(request.headers["x-session-id"]).toBe("openrouter-session-1");
		expect(request.headers["x-session-affinity"]).toBeUndefined();
	});

	it("omits OpenRouter session headers when cacheRetention is none", async () => {
		const request = await captureAnthropicRequest(createOpenRouterModel(), createContext(), {
			sessionId: "openrouter-session-2",
			cacheRetention: "none",
		});

		expect(request.headers["x-session-id"]).toBeUndefined();
		expect(request.headers["x-session-affinity"]).toBeUndefined();
	});

	it("allows OpenRouter session headers to be disabled", async () => {
		const model = { ...createOpenRouterModel(), compat: { sendSessionAffinityHeaders: false } };
		const request = await captureAnthropicRequest(model, createContext(), {
			sessionId: "openrouter-session-3",
		});

		expect(request.headers["x-session-id"]).toBeUndefined();
	});

	it("omits cache_control on tools for Fireworks models", async () => {
		const model = createFireworksModel();
		const request = await captureAnthropicRequest(model, createContext());

		const tools = getTools(request.body);
		const lastTool = tools[tools.length - 1];
		expect(lastTool.cache_control).toBeUndefined();
	});

	it("omits eager_input_streaming on tools for Fireworks models", async () => {
		const model = createFireworksModel();
		const request = await captureAnthropicRequest(model, createContext());

		const tools = getTools(request.body);
		for (const t of tools) {
			expect(t.eager_input_streaming).toBeUndefined();
		}
	});

	it("sends cache_control on tools for native Anthropic models", async () => {
		const model = createAnthropicModel();
		const request = await captureAnthropicRequest(model, createContext());

		const tools = getTools(request.body);
		const lastTool = tools[tools.length - 1];
		expect(lastTool.cache_control).toBeDefined();
		expect((lastTool.cache_control as { type: string }).type).toBe("ephemeral");
	});

	it("sends eager_input_streaming on tools for native Anthropic models", async () => {
		const model = createAnthropicModel();
		const request = await captureAnthropicRequest(model, createContext());

		const tools = getTools(request.body);
		expect(tools[0].eager_input_streaming).toBe(true);
	});
});
