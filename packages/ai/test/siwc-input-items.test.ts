import { describe, expect, it } from "vitest";
import { stream } from "../src/api/openai-responses.ts";
import { getModels } from "../src/compat.ts";
import type { AssistantMessage, Message, Model, OpenAIResponsesCompat } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// senpi#6607: the Sign in with ChatGPT route rejects every input item type outside its documented list
// with 400 subscription_sharing_unsupported_capability. Contract: the SIWC preview-limitations list
// (text/image/file messages, item references, additional tools, compaction summaries, reasoning,
// web search calls, function and custom tool calls), read off the request body the SDK sends.
const SIWC_INPUT_ITEM_TYPES = new Set([
	"message",
	"item_reference",
	"additional_tools",
	"compaction",
	"reasoning",
	"web_search_call",
	"function_call",
	"function_call_output",
	"custom_tool_call",
	"custom_tool_call_output",
]);

function siwcModel(id: string): Model<"openai-responses"> {
	const catalog = getModels("chatgpt-subscription").find((model) => model.id === id);
	if (!catalog) throw new Error(`Missing catalog model chatgpt-subscription/${id}`);
	return {
		...catalog,
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		compat: { ...(catalog.compat as OpenAIResponsesCompat), siwc: true, webSearchToolType: "web_search" },
	} as Model<"openai-responses">;
}

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(provider: string, api: string, model: string, content: AssistantMessage["content"]): Message {
	return { role: "assistant", content, api, provider, model, usage, stopReason: "toolUse", timestamp: 1 };
}

async function sentBody(model: Model<"openai-responses">, messages: Message[], reasoningEffort: "medium") {
	let body: { input: Array<{ type?: string; role?: string }>; reasoning?: { effort?: string } } | undefined;
	const source = stream(model, normalizeContext({ systemPrompt: "system", messages, tools: [] }), {
		apiKey: "synthetic-test-token",
		maxRetries: 0,
		reasoningEffort,
		fetch: async (_input, init) => {
			body = JSON.parse(String(init?.body));
			const done = { type: "response.completed", response: { id: "r", status: "completed", output: [] } };
			return new Response(`data: ${JSON.stringify(done)}\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	});
	await source.result();
	if (body === undefined) throw new Error("no request was sent");
	return body;
}

describe("SIWC input items (senpi#6607)", () => {
	it("sends only accepted item types and carries a mid-session effort change as the request effort", async () => {
		const model = siwcModel("gpt-6.1-sol");
		const messages: Message[] = [
			{ role: "user", content: "start", timestamp: 1 },
			assistant("anthropic-subscription", "anthropic-messages", "claude-opus-5-5", [
				{ type: "thinking", thinking: "plan", thinkingSignature: "sig" },
				{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a" } },
			]),
			{
				role: "toolResult",
				toolCallId: "toolu_1",
				toolName: "read",
				content: [
					{ type: "text", text: "file" },
					{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
				],
				isError: false,
				timestamp: 2,
			},
			{ role: "configurationUpdate", content: [], effort: "high", timestamp: 3 },
			{ role: "user", content: "next", timestamp: 4 },
		];
		const body = await sentBody(model, messages, "medium");
		const types = body.input.map((item) => item.type ?? (item.role === undefined ? "?" : "message"));
		expect(types.filter((type) => !SIWC_INPUT_ITEM_TYPES.has(type))).toEqual([]);
		expect(body.reasoning?.effort).toBe(model.thinkingLevelMap?.high ?? "high");
	});

	// senpi#6655: an update to `off` drops the requested effort instead of keeping the baseline. No flagged
	// subscription model can turn reasoning off (`thinkingLevelMap.off` is null), so no effort is sent at all.
	it("carries an update to off as no requested effort", async () => {
		const messages: Message[] = [
			{ role: "user", content: "start", timestamp: 1 },
			{ role: "configurationUpdate", content: [], effort: "off", timestamp: 2 },
			{ role: "user", content: "next", timestamp: 3 },
		];
		const body = await sentBody(siwcModel("gpt-6.1-sol"), messages, "medium");
		expect(body.reasoning).toBeUndefined();
	});

	it("keeps the requested effort when the history carries no update", async () => {
		const body = await sentBody(siwcModel("gpt-6.1-sol"), [{ role: "user", content: "hi", timestamp: 1 }], "medium");
		expect(body.reasoning?.effort).toBe("medium");
	});
});
