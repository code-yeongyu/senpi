import { beforeEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/compat.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context, Model } from "../src/types.ts";

interface AnthropicToolPayload {
	tools?: Array<{ name: string; input_schema: { properties?: Record<string, unknown>; required?: string[] } }>;
}

interface AnthropicMockState {
	createParams: AnthropicToolPayload | undefined;
}

const mockState = vi.hoisted<AnthropicMockState>(() => ({ createParams: undefined }));

vi.mock("@anthropic-ai/sdk", () => {
	function createSseResponse(): Response {
		const body = [
			`event: message_start\ndata: ${JSON.stringify({
				type: "message_start",
				message: { id: "msg_test", usage: { input_tokens: 10, output_tokens: 0 } },
			})}\n`,
			`event: message_delta\ndata: ${JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 5 },
			})}\n`,
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n`,
		].join("\n");

		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	}

	class FakeAnthropic {
		private readonly create = (params: AnthropicToolPayload) => {
			mockState.createParams = params;
			return { asResponse: async () => createSseResponse() };
		};
		beta = { messages: { create: this.create } };
		messages = { create: this.create };
	}

	return { default: FakeAnthropic };
});

// Plugin and MCP tools ship root unions routinely and senpi cannot flatten a
// schema it does not own. The Anthropic conversion reads top-level properties
// only, so these arrived as {"properties":{},"required":[]}: a parameterless tool.
const rootUnionContext: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	tools: [
		{
			name: "monitor",
			description: "Subscribe to a command's output",
			parameters: {
				anyOf: [
					{
						type: "object",
						properties: { command: { type: "string" }, description: { type: "string" } },
						required: ["command", "description"],
					},
					{
						type: "object",
						properties: { bash_id: { type: "string" } },
						required: ["bash_id"],
					},
				],
			},
		},
	],
};

async function capturePayload(model: Model<"anthropic-messages">, context: Context): Promise<AnthropicToolPayload> {
	await streamAnthropic({ ...model, baseUrl: "http://127.0.0.1:9" }, context, { apiKey: "fake-key" }).result();
	if (!mockState.createParams) throw new Error("Expected payload to be captured");
	return mockState.createParams;
}

describe("Anthropic root-union tool schemas", () => {
	beforeEach(() => {
		mockState.createParams = undefined;
	});

	it("sends the union's parameters instead of an empty schema", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), rootUnionContext);

		const schema = payload.tools?.[0]?.input_schema;
		expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(["bash_id", "command", "description"]);
	});

	it("requires only what every branch of the union requires", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), rootUnionContext);

		// `command` is required by one branch only, so forcing it globally would
		// reject calls the union accepts.
		expect(payload.tools?.[0]?.input_schema.required).toEqual([]);
	});

	it("leaves an ordinary object schema untouched", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"), {
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			tools: [
				{
					name: "get_weather",
					description: "Get the weather",
					parameters: {
						type: "object",
						properties: { city: { type: "string" } },
						required: ["city"],
					},
				},
			],
		});

		expect(payload.tools?.[0]?.input_schema.properties).toEqual({ city: { type: "string" } });
		expect(payload.tools?.[0]?.input_schema.required).toEqual(["city"]);
	});
});
