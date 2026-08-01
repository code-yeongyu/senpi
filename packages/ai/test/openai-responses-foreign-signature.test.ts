import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModel } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, Usage } from "../src/types.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function sameModelAssistant(
	model: Model<"openai-codex-responses">,
	content: AssistantMessage["content"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function makeContext(assistant: AssistantMessage): Context {
	return {
		systemPrompt: "You are concise.",
		messages: [{ role: "user", content: "Hi", timestamp: Date.now() - 1000 }, assistant],
	};
}

const ALLOWED_TOOL_CALL_PROVIDERS = new Set(["openai", "openai-codex", "opencode"]);

type ResponsesInput = ReturnType<typeof convertResponsesMessages>;

function assistantTexts(input: ResponsesInput): string[] {
	const texts: string[] = [];
	for (const item of input) {
		if (item.type !== "message" || item.role !== "assistant") continue;
		const content = item.content;
		if (typeof content === "string") {
			texts.push(content);
			continue;
		}
		for (const block of content) {
			if ("text" in block && typeof block.text === "string") texts.push(block.text);
		}
	}
	return texts;
}

describe("OpenAI Responses foreign thinking-signature replay", () => {
	const model = getModel("openai-codex", "gpt-5.5");

	it("demotes a Kimi-style field-name signature to plain text instead of throwing", () => {
		const assistant = sameModelAssistant(model, [
			{ type: "thinking", thinking: "deeply considered result", thinkingSignature: "reasoning_content" },
			{ type: "text", text: "answer" },
		]);

		const input = convertResponsesMessages(model, makeContext(assistant), ALLOWED_TOOL_CALL_PROVIDERS);

		expect(assistantTexts(input)).toContain("deeply considered result");
		expect(input.some((item) => item.type === "reasoning")).toBe(false);
	});

	it("demotes an Anthropic opaque signature to plain text instead of throwing", () => {
		const assistant = sameModelAssistant(model, [
			{ type: "thinking", thinking: "claude was here", thinkingSignature: "EqQBCkYICxgCKkFudGVzdA==" },
		]);

		const input = convertResponsesMessages(model, makeContext(assistant), ALLOWED_TOOL_CALL_PROVIDERS);

		expect(input.some((item) => item.type === "reasoning")).toBe(false);
		expect(assistantTexts(input)).toContain("claude was here");
	});

	it("drops JSON signatures that are not reasoning items", () => {
		const assistant = sameModelAssistant(model, [
			{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify({ type: "message", id: "msg_x" }) },
		]);

		const input = convertResponsesMessages(model, makeContext(assistant), ALLOWED_TOOL_CALL_PROVIDERS);

		expect(input.some((item) => item.type === "reasoning")).toBe(false);
	});

	it("still replays genuine reasoning items verbatim", () => {
		const reasoningItem = { type: "reasoning", id: "rs_abc123", summary: [] };
		const assistant = sameModelAssistant(model, [
			{ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(reasoningItem) },
		]);

		const input = convertResponsesMessages(model, makeContext(assistant), ALLOWED_TOOL_CALL_PROVIDERS);

		const replayed = input.find((item) => item.type === "reasoning");
		expect(replayed).toBeDefined();
		expect((replayed as { id?: string }).id).toBe("rs_abc123");
	});
});
