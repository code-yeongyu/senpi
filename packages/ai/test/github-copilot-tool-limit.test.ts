import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { stream as streamOpenAIResponses } from "../src/api/openai-responses.ts";
import type { Api, AssistantMessage, Context, Model, Tool } from "../src/types.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

const COPILOT_TOOL_LIMIT = 128;

function makeTools(count: number): Tool[] {
	return Array.from({ length: count }, (_, index) => ({
		name: `tool_${index}`,
		description: `Tool ${index}`,
		parameters: Type.Object({}),
	}));
}

function makeModel<TApi extends Api>(api: TApi): Model<TApi> {
	return {
		id: "test-model",
		name: "Test model",
		api,
		provider: "github-copilot",
		baseUrl: "https://api.individual.githubcopilot.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function makeContext(): Context {
	return {
		messages: [{ role: "user", content: "Use a tool.", timestamp: 1 }],
		tools: makeTools(COPILOT_TOOL_LIMIT + 2),
	};
}

async function captureRequest(
	run: (fetch: typeof globalThis.fetch) => Promise<AssistantMessage>,
): Promise<{ payload: { tools?: unknown[] }; result: AssistantMessage }> {
	let payload: { tools?: unknown[] } | undefined;
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		payload = JSON.parse(String(init?.body)) as { tools?: unknown[] };
		return new Response("Bad Request", { status: 400, headers: { "content-type": "text/plain" } });
	};
	const result = await run(fetch);
	if (payload === undefined) throw new Error("Expected the adapter to send a request");
	return { payload, result };
}

function expectLimited(payload: { tools?: unknown[] }, result: AssistantMessage): void {
	expect(payload.tools).toHaveLength(COPILOT_TOOL_LIMIT);
	expect(result.diagnostics).toContainEqual(
		expect.objectContaining({
			type: "github_copilot_tool_limit",
			timestamp: expect.any(Number),
			details: expect.objectContaining({ limit: COPILOT_TOOL_LIMIT, omittedCount: 2 }),
		}),
	);
	expect(result.errorMessage).toContain("senpi limited its tool list to 128");
	expect(result.providerDiagnostic).toMatchObject({
		category: "invalid_request",
		httpStatus: 400,
		evidence: "structured_status",
	});
}

function wireToolNames(payload: { tools?: unknown[] }): string[] {
	return (payload.tools ?? []).flatMap((tool): string[] => {
		if (typeof tool !== "object" || tool === null) return [];
		const record = tool as Record<string, unknown>;
		if (record.type === "function" && typeof record.function === "object" && record.function !== null) {
			const name = (record.function as Record<string, unknown>).name;
			return typeof name === "string" ? [name] : [];
		}
		return typeof record.name === "string" ? [record.name] : [];
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

describe("GitHub Copilot tool limit", () => {
	it("limits Chat Completions requests and reports omitted tools", async () => {
		const context = makeContext();
		const { payload, result } = await captureRequest((fetch) =>
			streamOpenAICompletions(makeModel("openai-completions"), normalizeContext(context), {
				apiKey: "test-key",
				fetch,
				maxRetries: 0,
			}).result(),
		);

		expectLimited(payload, result);
		expect(wireToolNames(payload)).toEqual(Array.from({ length: COPILOT_TOOL_LIMIT }, (_, index) => `tool_${index}`));
		expect(context.tools).toHaveLength(COPILOT_TOOL_LIMIT + 2);
	});

	it("limits Responses requests and reports omitted tools", async () => {
		const context = makeContext();
		const { payload, result } = await captureRequest((fetch) =>
			streamOpenAIResponses(makeModel("openai-responses"), normalizeContext(context), {
				apiKey: "test-key",
				fetch,
				maxRetries: 0,
			}).result(),
		);

		expectLimited(payload, result);
		expect(context.tools).toHaveLength(COPILOT_TOOL_LIMIT + 2);
	});

	it("limits Anthropic Messages requests and reports omitted tools", async () => {
		const context = makeContext();
		const { payload, result } = await captureRequest((fetch) =>
			streamAnthropic(makeModel("anthropic-messages"), normalizeContext(context), {
				apiKey: "test-key",
				fetch,
				maxRetries: 0,
			}).result(),
		);

		expectLimited(payload, result);
		expect(context.tools).toHaveLength(COPILOT_TOOL_LIMIT + 2);
	});

	it("keeps a forced Chat Completions tool from beyond the first 128", async () => {
		const context = makeContext();
		const { payload } = await captureRequest((fetch) =>
			streamOpenAICompletions(makeModel("openai-completions"), normalizeContext(context), {
				apiKey: "test-key",
				fetch,
				maxRetries: 0,
				toolChoice: { type: "function", function: { name: "tool_129" } },
			}).result(),
		);

		expect(wireToolNames(payload)).toEqual([
			...Array.from({ length: COPILOT_TOOL_LIMIT - 1 }, (_, index) => `tool_${index}`),
			"tool_129",
		]);
	});

	it("keeps a forced Responses tool from beyond the first 128", async () => {
		const context = makeContext();
		const { payload } = await captureRequest((fetch) =>
			streamOpenAIResponses(makeModel("openai-responses"), normalizeContext(context), {
				apiKey: "test-key",
				fetch,
				maxRetries: 0,
				toolChoice: { type: "function", name: "tool_129" },
			}).result(),
		);

		expect(wireToolNames(payload).at(-1)).toBe("tool_129");
	});

	it("keeps a forced Anthropic tool from beyond the first 128", async () => {
		const context = makeContext();
		const { payload } = await captureRequest((fetch) =>
			streamAnthropic(makeModel("anthropic-messages"), normalizeContext(context), {
				apiKey: "test-key",
				fetch,
				maxRetries: 0,
				toolChoice: { type: "tool", name: "tool_129" },
			}).result(),
		);

		expect(wireToolNames(payload).at(-1)).toBe("tool_129");
	});

	it("applies the cap after payload hooks and keeps a hook-forced tool", async () => {
		const context = makeContext();
		const { payload } = await captureRequest((fetch) =>
			streamOpenAICompletions(makeModel("openai-completions"), normalizeContext(context), {
				apiKey: "test-key",
				fetch,
				maxRetries: 0,
				onPayload: (current) => {
					if (!isRecord(current)) throw new Error("Expected an object payload");
					const tools = Array.isArray(current.tools) ? current.tools : [];
					return {
						...current,
						tools: [
							...tools,
							{
								type: "function",
								function: {
									name: "tool_from_hook",
									description: "Hook tool",
									parameters: { type: "object", properties: {} },
								},
							},
						],
						tool_choice: { type: "function", function: { name: "tool_from_hook" } },
					};
				},
			}).result(),
		);

		expect(payload.tools).toHaveLength(COPILOT_TOOL_LIMIT);
		expect(wireToolNames(payload).at(-1)).toBe("tool_from_hook");
	});

	it("leaves non-Copilot requests unchanged", async () => {
		const context = makeContext();
		const nonCopilotModel = { ...makeModel("openai-completions"), provider: "test-provider" };
		const { payload, result } = await captureRequest((fetch) =>
			streamOpenAICompletions(nonCopilotModel, normalizeContext(context), {
				apiKey: "test-key",
				fetch,
				maxRetries: 0,
			}).result(),
		);

		expect(payload.tools).toHaveLength(COPILOT_TOOL_LIMIT + 2);
		expect(result.diagnostics?.some((diagnostic) => diagnostic.type === "github_copilot_tool_limit")).not.toBe(true);
	});

	it("does not add structured diagnostics to non-Copilot Responses errors", async () => {
		const context = makeContext();
		const nonCopilotModel = { ...makeModel("openai-responses"), provider: "test-provider" };
		const { payload, result } = await captureRequest((fetch) =>
			streamOpenAIResponses(nonCopilotModel, normalizeContext(context), {
				apiKey: "test-key",
				fetch,
				maxRetries: 0,
			}).result(),
		);

		expect(payload.tools).toHaveLength(COPILOT_TOOL_LIMIT + 2);
		expect(result.providerDiagnostic).toBeUndefined();
	});
});
