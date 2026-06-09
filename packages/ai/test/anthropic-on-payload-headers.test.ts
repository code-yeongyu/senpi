import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	createParams: undefined as Record<string, unknown> | undefined,
	requestOptions: undefined as Record<string, unknown> | undefined,
	constructorOptions: undefined as { defaultHeaders?: Record<string, string | null> } | undefined,
}));
const unsupportedNativeComputerToolModels = [["claude-opus-4-6"], ["claude-opus-4-7"], ["claude-opus-4-8"]] as const;
const cloudflareAnthropicModel = {
	...getModel("anthropic", "claude-sonnet-4-5"),
	provider: "cloudflare-ai-gateway",
	baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic",
} as const;

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					usage: { input_tokens: 10, output_tokens: 0 },
				},
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");

		return new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}

	class FakeAnthropic {
		constructor(options: { defaultHeaders?: Record<string, string | null> }) {
			mockState.constructorOptions = options;
		}

		messages = {
			create: (params: Record<string, unknown>, requestOptions: Record<string, unknown>) => {
				mockState.createParams = params;
				mockState.requestOptions = requestOptions;
				return {
					asResponse: async () => createSseResponse(),
				};
			},
		};
	}

	return { default: FakeAnthropic };
});

describe("Anthropic onPayload request metadata", () => {
	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};

	beforeEach(() => {
		mockState.createParams = undefined;
		mockState.requestOptions = undefined;
		mockState.constructorOptions = undefined;
	});

	it("forwards hook-added headers to SDK request options without leaking metadata into the body", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");

		const stream = streamAnthropic(model, context, {
			apiKey: "fake-key",
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				headers: { "anthropic-beta": "computer-use-2025-01-24" },
				extra_body: { betas: ["computer-use-2025-01-24"] },
			}),
		});

		await stream.result();

		expect(mockState.requestOptions?.headers).toEqual({ "anthropic-beta": "computer-use-2025-01-24" });
		expect(mockState.createParams).not.toHaveProperty("headers");
		expect(mockState.createParams).not.toHaveProperty("extra_body");
	});

	it.each(
		unsupportedNativeComputerToolModels,
	)("strips native computer-use tools that %s rejects after payload hooks run", async (modelId) => {
		const model = getModel("anthropic", modelId);

		const stream = streamAnthropic(model, context, {
			apiKey: "fake-key",
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				tools: [
					{
						type: "computer_20250124",
						name: "computer",
						display_width_px: 1024,
						display_height_px: 768,
						display_number: 1,
					},
					{ type: "bash_20250124", name: "bash" },
				],
				headers: {
					"anthropic-beta": "computer-use-2025-01-24, fine-grained-tool-streaming-2025-05-14",
				},
			}),
		});

		await stream.result();

		const tools = mockState.createParams?.tools as Array<Record<string, unknown>>;
		expect(tools.some((tool) => tool.type === "computer_20250124")).toBe(false);
		expect(tools).toContainEqual({ type: "bash_20250124", name: "bash" });
		expect(mockState.requestOptions?.headers).toEqual({
			"anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
		});
	});

	it("normalizes hook-returned legacy thinking for Claude Opus 4.6 before SDK request", async () => {
		const model = getModel("anthropic", "claude-opus-4-6");

		const stream = streamAnthropic(model, context, {
			apiKey: "fake-key",
			thinkingEnabled: true,
			effort: "high",
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				thinking: { type: "enabled", budget_tokens: 4096, display: "summarized" },
			}),
		});

		await stream.result();

		expect(mockState.createParams?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(mockState.createParams?.output_config).toEqual({ effort: "high" });
		expect(JSON.stringify(mockState.createParams)).not.toContain('"type":"enabled"');
	});

	it("preserves hook-returned legacy thinking for non-adaptive models", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");

		const stream = streamAnthropic(model, context, {
			apiKey: "fake-key",
			thinkingEnabled: true,
			thinkingBudgetTokens: 4096,
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				thinking: { type: "enabled", budget_tokens: 4096, display: "summarized" },
			}),
		});

		await stream.result();

		expect(mockState.createParams?.thinking).toEqual({
			type: "enabled",
			budget_tokens: 4096,
			display: "summarized",
		});
		expect(mockState.createParams?.output_config).toBeUndefined();
	});

	it("strips caller-supplied interleaved thinking beta for adaptive models", async () => {
		const model = {
			...getModel("anthropic", "claude-opus-4-6"),
			headers: {
				"anthropic-beta": "interleaved-thinking-2025-05-14, fine-grained-tool-streaming-2025-05-14",
			},
		};

		const stream = streamAnthropic(model, context, {
			apiKey: "fake-key",
			interleavedThinking: true,
			headers: {
				"anthropic-beta": "interleaved-thinking-2025-05-14, fine-grained-tool-streaming-2025-05-14",
			},
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				headers: {
					"anthropic-beta": "interleaved-thinking-2025-05-14, fine-grained-tool-streaming-2025-05-14",
				},
			}),
		});

		await stream.result();

		expect(mockState.constructorOptions?.defaultHeaders?.["anthropic-beta"]).toBe(
			"fine-grained-tool-streaming-2025-05-14",
		);
		expect(mockState.requestOptions?.headers).toEqual({
			"anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
		});
	});

	it("strips native computer-use tools from Cloudflare Anthropic routes after payload hooks run", async () => {
		const stream = streamAnthropic(cloudflareAnthropicModel, context, {
			apiKey: "fake-key",
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				tools: [
					{
						type: "computer_20250124",
						name: "computer",
						display_width_px: 1024,
						display_height_px: 768,
						display_number: 1,
					},
					{
						type: "computer_20251124",
						name: "computer",
						display_width_px: 1024,
						display_height_px: 768,
						display_number: 1,
					},
					{ type: "bash_20250124", name: "bash" },
					{ type: "text_editor_20250124", name: "str_replace_editor" },
				],
				tool_choice: { type: "tool", name: "computer" },
				headers: {
					"anthropic-beta":
						"computer-use-2025-01-24, computer-use-2025-11-24, fine-grained-tool-streaming-2025-05-14",
				},
			}),
		});

		await stream.result();

		const tools = mockState.createParams?.tools as Array<Record<string, unknown>>;
		expect(tools.some((tool) => typeof tool.type === "string" && tool.type.startsWith("computer_"))).toBe(false);
		expect(tools).toContainEqual({ type: "bash_20250124", name: "bash" });
		expect(tools).toContainEqual({ type: "text_editor_20250124", name: "str_replace_editor" });
		expect(mockState.createParams?.tool_choice).toBeUndefined();
		expect(mockState.requestOptions?.headers).toEqual({
			"anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
		});
	});
});
