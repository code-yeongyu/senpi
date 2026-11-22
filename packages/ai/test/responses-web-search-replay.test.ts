import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

describe("Responses search item replay (#3122)", () => {
	const model = getModel("chatgpt-subscription", "gpt-5.5");
	const search = {
		type: "web_search_call",
		id: "ws_replay",
		status: "completed",
		action: {
			type: "search",
			query: "official documentation",
			sources: [{ type: "url", url: "https://example.com" }],
		},
	};
	const assistant: AssistantMessage = {
		role: "assistant",
		provider: model.provider,
		api: model.api,
		model: model.id,
		content: [
			{ type: "providerNative", subtype: "web_search_call", raw: search },
			{ type: "text", text: "Found the docs." },
		],
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const context: Context = {
		messages: [
			{ role: "user", content: "Find the docs", timestamp: 0 },
			assistant,
			{ role: "user", content: "Use the previous result", timestamp: 2 },
		],
	};

	it("preserves completed native search output on the same model without mutating stored blocks", () => {
		const input = convertResponsesMessages(model, normalizeContext(context), new Set([model.provider]));
		expect(input).toContainEqual(search);
		expect(assistant.content[0]).toEqual({ type: "providerNative", subtype: "web_search_call", raw: search });
	});

	it("does not replay opaque native search output after changing provider or model", () => {
		for (const destination of [
			{ ...model, provider: "another-provider" },
			{ ...model, id: "another-model" },
		]) {
			const input = convertResponsesMessages(
				destination,
				normalizeContext(context),
				new Set([destination.provider]),
			);
			expect(input.some((item) => item.type === "web_search_call")).toBe(false);
		}
	});
});
