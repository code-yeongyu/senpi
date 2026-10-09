import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/compat.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Model } from "../src/types.ts";
import { clearForcedToolChoiceRefusals } from "../src/utils/tool-choice-fallback.ts";

import { normalizeContext } from "../src/utils/transcript.ts";

interface AnthropicToolChoicePayload {
	tools?: unknown[];
	tool_choice?: unknown;
}

interface AnthropicMockState {
	createParams: AnthropicToolChoicePayload | undefined;
	createCalls: AnthropicToolChoicePayload[];
	createErrors: Error[];
}

const mockState = vi.hoisted<AnthropicMockState>(() => ({
	createParams: undefined,
	createCalls: [],
	createErrors: [],
}));

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
		private readonly create = (params: AnthropicToolChoicePayload) => {
			mockState.createParams = params;
			mockState.createCalls.push(params);
			const createError = mockState.createErrors.shift();
			return {
				asResponse: async () => {
					if (createError) throw createError;
					return createSseResponse();
				},
			};
		};
		beta = { messages: { create: this.create } };
		messages = { create: this.create };
	}

	return { default: FakeAnthropic };
});

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	tools: [
		{
			name: "get_weather",
			description: "Get the weather",
			parameters: {
				type: "object",
				properties: {
					city: { type: "string" },
				},
				required: ["city"],
			},
		},
	],
};

// Models with upstream native tool changes (decisions.md L2d) also declare upstream's stable
// deferred placeholder; the caller's tools are every declaration except that placeholder.
const DEFERRED_TOOL_PLACEHOLDER_NAME = "__pi_deferred_placeholder__";

function callerToolNames(payload: AnthropicToolChoicePayload): unknown[] {
	return (payload.tools ?? [])
		.map((tool) => (typeof tool === "object" && tool !== null && "name" in tool ? tool.name : tool))
		.filter((name) => name !== DEFERRED_TOOL_PLACEHOLDER_NAME);
}

function withPayloadCapture(model: Model<"anthropic-messages">): Model<"anthropic-messages"> {
	return { ...model, baseUrl: "http://127.0.0.1:9" };
}

class HttpStatusError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	toolChoice: "auto" | "any" | "none" | { type: "tool"; name: string },
): Promise<AnthropicToolChoicePayload> {
	const stream = streamAnthropic(withPayloadCapture(model), normalizeContext(context), {
		apiKey: "fake-key",
		toolChoice,
	});

	await stream.result();

	if (!mockState.createParams) {
		throw new Error("Expected payload to be captured before request completion");
	}

	return mockState.createParams;
}

describe("Anthropic tool_choice compatibility", () => {
	beforeEach(() => {
		clearForcedToolChoiceRefusals();
		mockState.createParams = undefined;
		mockState.createCalls.length = 0;
		mockState.createErrors.length = 0;
	});

	it("omits forced any tool_choice for Claude Fable while preserving tools", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), "any");

		expect(callerToolNames(payload)).toEqual(["get_weather"]);
		expect(payload.tool_choice).toBeUndefined();
	});

	it("omits forced named tool_choice for Claude Fable while preserving tools", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), {
			type: "tool",
			name: "get_weather",
		});

		expect(callerToolNames(payload)).toEqual(["get_weather"]);
		expect(payload.tool_choice).toBeUndefined();
	});

	it("keeps auto tool_choice for Claude Fable", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), "auto");

		expect(callerToolNames(payload)).toEqual(["get_weather"]);
		expect(payload.tool_choice).toEqual({ type: "auto" });
	});

	it("omits forced any tool_choice for Claude Opus 5.5 while preserving tools", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-5-5"), "any");

		expect(callerToolNames(payload)).toEqual(["get_weather"]);
		expect(payload.tool_choice).toBeUndefined();
	});

	it("omits forced named tool_choice for a gateway Opus 5.5 row with no compat", async () => {
		const model: Model<"anthropic-messages"> = {
			...getModel("anthropic", "claude-opus-5-5"),
			provider: "custom-gateway",
			compat: undefined,
		};

		const payload = await capturePayload(model, { type: "tool", name: "get_weather" });

		expect(callerToolNames(payload)).toEqual(["get_weather"]);
		expect(payload.tool_choice).toBeUndefined();
	});

	it("keeps auto tool_choice for Claude Opus 5.5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-5-5"), "auto");

		expect(callerToolNames(payload)).toEqual(["get_weather"]);
		expect(payload.tool_choice).toEqual({ type: "auto" });
	});

	it("keeps forced named tool_choice for Claude Opus 5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-5"), "any");

		expect(callerToolNames(payload)).toEqual(["get_weather"]);
		expect(payload.tool_choice).toEqual({ type: "any" });
	});

	it("keeps forced named tool_choice for Claude Sonnet 4.6", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-6"), {
			type: "tool",
			name: "get_weather",
		});

		expect(callerToolNames(payload)).toEqual(["get_weather"]);
		expect(payload.tool_choice).toEqual({ type: "tool", name: "get_weather" });
	});

	it("retries forced named tool_choice 400 once without tool_choice", async () => {
		mockState.createErrors.push(
			new HttpStatusError(400, "tool_choice forces tool use is not compatible with this model"),
		);

		const response = await streamAnthropic(
			withPayloadCapture(getModel("anthropic", "claude-sonnet-4-6")),
			normalizeContext(context),
			{
				apiKey: "fake-key",
				toolChoice: { type: "tool", name: "get_weather" },
			},
		).result();

		expect(response.stopReason).toBe("stop");
		expect(mockState.createCalls).toHaveLength(2);
		expect(mockState.createCalls[0]?.tool_choice).toEqual({ type: "tool", name: "get_weather" });
		expect(mockState.createCalls[1]?.tool_choice).toBeUndefined();
	});

	it("retries without tool_choice when extended thinking rejects the forced choice", async () => {
		mockState.createErrors.push(
			new HttpStatusError(400, "Thinking may not be enabled when tool_choice forces tool use."),
		);

		const response = await streamAnthropic(
			withPayloadCapture(getModel("anthropic", "claude-sonnet-4-6")),
			normalizeContext(context),
			{
				apiKey: "fake-key",
				toolChoice: { type: "tool", name: "get_weather" },
			},
		).result();

		expect(response.stopReason).toBe("stop");
		expect(mockState.createCalls).toHaveLength(2);
		expect(mockState.createCalls[1]?.tool_choice).toBeUndefined();
	});

	it("remembers an unconditional refusal for the model but not one that blames thinking (senpi#2218)", async () => {
		const forceWeather = (model: Model<"anthropic-messages">) =>
			streamAnthropic(withPayloadCapture(model), normalizeContext(context), {
				apiKey: "fake-key",
				toolChoice: { type: "tool", name: "get_weather" },
			}).result();
		const sonnet = getModel("anthropic", "claude-sonnet-4-6");
		const opus = getModel("anthropic", "claude-opus-5");

		mockState.createErrors.push(
			new HttpStatusError(400, "tool_choice forces tool use is not compatible with this model"),
		);
		await forceWeather(sonnet);
		mockState.createErrors.push(
			new HttpStatusError(400, "Thinking may not be enabled when tool_choice forces tool use."),
		);
		await forceWeather(opus);
		await forceWeather(sonnet);
		await forceWeather(opus);

		expect(mockState.createCalls.map((call) => call.tool_choice)).toEqual([
			{ type: "tool", name: "get_weather" },
			undefined,
			{ type: "tool", name: "get_weather" },
			undefined,
			undefined,
			{ type: "tool", name: "get_weather" },
		]);
	});

	it("omits forced tool_choice when compat.supportsForcedToolChoice is false regardless of model id", async () => {
		const model: Model<"anthropic-messages"> = {
			...getModel("anthropic", "claude-sonnet-4-6"),
			compat: { supportsForcedToolChoice: false },
		};

		const payload = await capturePayload(model, {
			type: "tool",
			name: "get_weather",
		});

		expect(callerToolNames(payload)).toEqual(["get_weather"]);
		expect(payload.tool_choice).toBeUndefined();
	});

	it("omits auto tool_choice when compat.supportsToolChoice is false", async () => {
		const model: Model<"anthropic-messages"> = {
			...getModel("anthropic", "claude-sonnet-4-6"),
			compat: { supportsToolChoice: false },
		};

		const payload = await capturePayload(model, "auto");

		expect(callerToolNames(payload)).toEqual(["get_weather"]);
		expect(payload.tool_choice).toBeUndefined();
	});
});
