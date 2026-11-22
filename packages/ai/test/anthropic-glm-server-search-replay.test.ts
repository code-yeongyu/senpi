import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/compat.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

describe("GLM coding-plan Anthropic server search", () => {
	it.each([true, false])(
		"surfaces paired tool_result with zero search usage and gates its replay on opt-in=%s",
		async (enabled) => {
			// senpi#3125: sanitized fixture from the lead's live z.ai Anthropic response.
			const model: Model<"anthropic-messages"> = {
				...getModel("anthropic", "claude-haiku-4-5"),
				provider: "zai",
				id: "glm-4.6",
				baseUrl: "https://api.z.ai/api/anthropic",
				compat: { supportsWebSearch: enabled },
			};
			const use = {
				type: "server_tool_use",
				id: "srvtoolu_glm_search",
				name: "web_search",
				input: { query: "latest Bun release" },
			};
			const result = {
				type: "tool_result",
				tool_use_id: use.id,
				content: [{ type: "text", text: "https://bun.com/blog" }],
			};
			const blocks = [
				{ type: "thinking", thinking: "Search for current sources.", signature: "fixture-signature-1" },
				use,
				result,
				{ type: "thinking", thinking: "Use the returned source.", signature: "fixture-signature-2" },
				{ type: "text", text: "The current release is listed at https://bun.com/blog." },
			];
			const events = [
				{
					type: "message_start",
					message: {
						id: "msg_fixture_glm",
						usage: { input_tokens: 3, output_tokens: 0, server_tool_use: { web_search_requests: 0 } },
					},
				},
				...blocks.flatMap((block, index) => [
					{ type: "content_block_start", index, content_block: block },
					{ type: "content_block_stop", index },
				]),
				{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
				{ type: "message_stop" },
			];
			const captured: unknown[] = [];
			const client = new Anthropic({
				apiKey: "fixture-key",
				fetch: async (_url, init) => {
					captured.push(JSON.parse(String(init?.body)));
					return new Response(
						events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
						{
							headers: { "content-type": "text/event-stream" },
						},
					);
				},
			});
			const user = { role: "user", content: "Find the latest Bun release.", timestamp: 1 } as const;
			const first = await streamAnthropic(model, normalizeContext({ messages: [user] }), { client }).result();
			expect(first.stopReason).toBe("stop");
			expect(first.content.filter((block) => block.type === "providerNative")).toEqual([
				{ type: "providerNative", subtype: "server_tool_use", raw: use },
				{ type: "providerNative", subtype: "tool_result", raw: result },
			]);
			await streamAnthropic(
				model,
				normalizeContext({
					messages: [user, first, { role: "user", content: "Continue using those sources.", timestamp: 2 }],
				}),
				{ client },
			).result();
			const replay = captured[1];
			if (!record(replay) || !Array.isArray(replay.messages)) throw new Error("Replay payload missing");
			const assistant = replay.messages.find((message: unknown) => record(message) && message.role === "assistant");
			if (!record(assistant) || !Array.isArray(assistant.content)) throw new Error("Replayed assistant missing");
			expect(
				assistant.content.filter(
					(block: unknown) => record(block) && [use.type, result.type].includes(String(block.type)),
				),
			).toEqual(enabled ? [use, result] : []);
		},
	);
});
