import { afterEach, describe, expect, it, vi } from "vitest";
import { openAICompletionsApi } from "../src/api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../src/api/openai-responses.lazy.ts";
import { createProvider } from "../src/models.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Message, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const intent = "Inspect the registered external read tool once.";
const previousUser = "The actual earlier user request.";
const previousAssistant = "The previous run finished.";
const reply = "NATIVE_CONTINUATION_REPLY";
type OpenAIApi = "openai-completions" | "openai-responses";

function modelFor(api: OpenAIApi): Model<OpenAIApi> {
	return {
		id: "gpt-wake-fixture",
		name: "Native continuation fixture",
		api,
		provider: "openai",
		baseUrl: "https://non-user.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32_000,
		maxTokens: 256,
	};
}

function responseFor(api: OpenAIApi): Response {
	const output = {
		type: "message",
		id: "msg_continuation",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text: reply, annotations: [] }],
	};
	const events =
		api === "openai-completions"
			? [
					{
						id: "chatcmpl_continuation",
						object: "chat.completion.chunk",
						created: 1,
						model: "gpt-wake-fixture",
						choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: "stop" }],
						usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
					},
				]
			: [
					{ type: "response.output_item.done", output_index: 0, item: output },
					{
						type: "response.completed",
						response: {
							id: "resp_continuation",
							status: "completed",
							output: [output],
							usage: {
								input_tokens: 1,
								output_tokens: 1,
								total_tokens: 2,
								input_tokens_details: { cached_tokens: 0 },
							},
						},
					},
				];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

afterEach(() => vi.restoreAllMocks());

describe.each(["openai-completions", "openai-responses"] as const)("%s native continuation wire contract", (api) => {
	it.each(["cold", "after-assistant"] as const)(
		"preserves %s input without fabricating a user carrier",
		async (history) => {
			const model = modelFor(api);
			const provider = createProvider({
				id: model.provider,
				models: [model],
				auth: { apiKey: { name: "Fixture", resolve: async () => undefined } },
				api: { [api]: api === "openai-completions" ? openAICompletionsApi() : openAIResponsesApi() },
			});
			const messages: Message[] =
				history === "cold"
					? []
					: [
							{ role: "user", content: previousUser, timestamp: 1 },
							{
								...fauxAssistantMessage(previousAssistant),
								api,
								provider: model.provider,
								model: model.id,
								timestamp: 2,
							},
						];
			const requests: Array<{
				path: string;
				body: { messages?: Array<{ role?: string }>; input?: Array<{ role?: string }> };
			}> = [];
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				const request = new Request(input, init);
				requests.push({ path: new URL(request.url).pathname, body: JSON.parse(await request.text()) });
				return responseFor(api);
			});

			// Capability and the real lazy SDK transport are exercised together: no mocked conversion or API client.
			expect(provider.supportsNonUserContinuation?.(model)).toBe(true);
			const result = await provider
				.streamSimple(model, normalizeContext({ systemPrompt: intent, messages }), {
					apiKey: "fixture-only",
					transport: "sse",
					maxRetries: 0,
				})
				.result();
			expect(result.stopReason, result.errorMessage).toBe("stop");
			expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: reply }));
			expect(requests).toHaveLength(1);
			expect(requests[0].path).toBe(api === "openai-completions" ? "/v1/chat/completions" : "/v1/responses");
			const body = requests[0].body;
			const input = api === "openai-completions" ? body.messages : body.input;
			expect(input).toBeDefined();
			expect(input?.filter((item) => item.role === "user")).toHaveLength(history === "cold" ? 0 : 1);
			expect(JSON.stringify(body)).toContain(intent);
			if (history === "after-assistant") {
				expect(input?.at(-1)?.role).toBe("assistant");
				expect(JSON.stringify(input)).toContain(previousUser);
				expect(JSON.stringify(input)).toContain(previousAssistant);
			} else {
				expect(input?.every((item) => item.role === "system" || item.role === "developer")).toBe(true);
			}
			expect(messages.filter((message) => message.role === "user")).toHaveLength(history === "cold" ? 0 : 1);
		},
	);
});
