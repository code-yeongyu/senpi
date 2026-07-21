import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/compat.ts";
import { streamOpenAIResponses } from "../src/providers/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

type CapturedPayload = Record<string, unknown> & {
	include?: unknown[];
	tool_choice?: unknown;
	tools?: Array<Record<string, unknown>>;
};

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

function createSseResponse(): Response {
	return new Response(
		`${[
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					id: "resp_web_search_compat",
					status: "completed",
					output: [],
					usage: {
						input_tokens: 0,
						output_tokens: 0,
						total_tokens: 0,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}`,
			"data: [DONE]",
		].join("\n\n")}\n\n`,
		{
			status: 200,
			headers: { "content-type": "text/event-stream" },
		},
	);
}

function readPayload(body: unknown): CapturedPayload {
	if (typeof body !== "string") {
		throw new Error("Expected OpenAI SDK fetch body to be a JSON string");
	}
	return JSON.parse(body) as CapturedPayload;
}

function createProxyModel(compat?: Model<"openai-responses">["compat"]): Model<"openai-responses"> {
	return {
		...getModel("openai", "gpt-5.5"),
		baseUrl: "https://quotio.example/v1",
		compat,
	};
}

async function captureFinalPayload(model: Model<"openai-responses">): Promise<CapturedPayload> {
	let capturedPayload: CapturedPayload | undefined;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
		capturedPayload = readPayload(init?.body);
		return createSseResponse();
	});

	const stream = streamOpenAIResponses(model, context, {
		apiKey: "test-key",
		onPayload: (payload) => ({
			...(payload as Record<string, unknown>),
			include: ["reasoning.encrypted_content", "web_search_call.action.sources"],
			tool_choice: { type: "web_search_preview" },
			tools: [{ type: "function", name: "keeper" }, { type: "web_search_preview" }],
		}),
	});

	await stream.result();

	if (!capturedPayload) {
		throw new Error("Expected OpenAI Responses request payload to be captured");
	}
	return capturedPayload;
}

describe("OpenAI Responses web_search_preview compatibility", () => {
	it("strips OpenAI native web search from custom Responses endpoints by default", async () => {
		const payload = await captureFinalPayload(createProxyModel());

		expect(payload.tools).toEqual([{ type: "function", name: "keeper" }]);
		expect(payload.include).toEqual(["reasoning.encrypted_content"]);
		expect(payload).not.toHaveProperty("tool_choice");
	});

	it("preserves OpenAI native web search when the custom endpoint opts in", async () => {
		const payload = await captureFinalPayload(createProxyModel({ supportsWebSearchPreview: true }));

		expect(payload.tools).toEqual([{ type: "function", name: "keeper" }, { type: "web_search_preview" }]);
		expect(payload.include).toEqual(["reasoning.encrypted_content", "web_search_call.action.sources"]);
		expect(payload.tool_choice).toEqual({ type: "web_search_preview" });
	});
});
