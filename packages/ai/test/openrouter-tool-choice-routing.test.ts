import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream } from "../src/api/openai-completions.ts";
import type { Model } from "../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "deepseek/deepseek-v4.1-flash",
	name: "DeepSeek",
	api: "openai-completions",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 131072,
	maxTokens: 1024,
};

// Captured OpenRouter 404: forcing todo removes DeepSeek before guardrails run.
const metadata = {
	failed_routing_step: "Filter by Guardrails",
	routing_funnel: [
		{ step: "Initial Endpoints", endpoint_count: 27 },
		{ step: "Filter by Tool Compatibility", endpoint_count: 19 },
	],
};

async function request(
	errorMetadata: unknown,
	choice: unknown = { type: "function", function: { name: "todo" } },
	failAgain = false,
) {
	const calls: Record<string, unknown>[] = [];
	const response = await stream(
		model,
		{
			messages: [{ role: "user", content: "Plan the work", timestamp: 0 }],
			tools: [{ name: "todo", description: "Plan", parameters: Type.Object({ op: Type.String() }) }],
		},
		{
			apiKey: "test",
			maxRetries: 0,
			// Exercise the same post-builder injection used by the first-turn todo extension.
			onPayload: (payload) => ({
				...(payload as Record<string, unknown>),
				...(choice === null ? {} : { tool_choice: choice }),
				provider: { only: ["DeepSeek"], allow_fallbacks: false },
			}),
			fetch: async (_url, init) => {
				calls.push(JSON.parse(String(init?.body)));
				if (calls.length === 1 || failAgain) {
					return Response.json(
						{ error: { code: 404, message: "No allowed endpoints", metadata: errorMetadata } },
						{ status: 404 },
					);
				}
				return new Response(
					`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
					{ headers: { "Content-Type": "text/event-stream" } },
				);
			},
		},
	).result();
	return { response, calls };
}

describe("OpenRouter forced tool routing", () => {
	it("retries the captured routing 404 once, removing only tool_choice", async () => {
		const { response, calls } = await request(metadata);
		expect(response.stopReason).toBe("stop");
		expect(response.content).toEqual([{ type: "text", text: "OK" }]);
		expect(calls).toHaveLength(2);
		const { tool_choice, ...rest } = calls[0]!;
		expect(tool_choice).toEqual({ type: "function", function: { name: "todo" } });
		expect(calls[1]).toEqual(rest);
	});

	it.each(["auto", "none", undefined])("does not retry an unforced choice (%s)", async (choice) => {
		const { response, calls } = await request(metadata, choice === undefined ? null : choice);
		expect(response.stopReason).toBe("error");
		expect(calls).toHaveLength(1);
	});

	it.each([
		undefined,
		{ failed_routing_step: "Filter by Guardrails" },
		{ ...metadata, routing_funnel: [{ step: "Initial Endpoints", endpoint_count: 27 }] },
		{ ...metadata, failed_routing_step: "Filter by Model" },
		{
			...metadata,
			routing_funnel: [metadata.routing_funnel[0], { step: "Filter by Tool Compatibility", endpoint_count: 27 }],
		},
		{
			...metadata,
			routing_funnel: [metadata.routing_funnel[0], { step: "Filter by Tool Compatibility", endpoint_count: "19" }],
		},
		{
			...metadata,
			routing_funnel: [metadata.routing_funnel[0], { step: "Filter by Tool Compatibility", endpoint_count: -1 }],
		},
		{ ...metadata, routing_funnel: [null, metadata.routing_funnel[1]] },
	])("leaves ordinary, guardrail-only, and malformed 404s terminal (%j)", async (errorMetadata) => {
		const { response, calls } = await request(errorMetadata);
		expect(response.stopReason).toBe("error");
		expect(calls).toHaveLength(1);
	});

	it("surfaces a second routing rejection without retrying again", async () => {
		const { response, calls } = await request(metadata, "required", true);
		expect(response.stopReason).toBe("error");
		expect(calls).toHaveLength(2);
		expect(calls[1]).not.toHaveProperty("tool_choice");
	});
});
