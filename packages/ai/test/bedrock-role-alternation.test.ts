import { describe, expect, it } from "vitest";
import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import type { AssistantMessage, CacheRetention, Message, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Regression for #2114: Bedrock Converse rejects adjacent same-role messages, so the adapter must fold them.

interface WireBlock {
	text?: string;
	cachePoint?: { type: string };
	toolResult?: { toolUseId: string };
	toolUse?: { toolUseId: string };
}

interface WirePayload {
	messages: Array<{ role: string; content: WireBlock[] }>;
}

const claudeModel: Model<"bedrock-converse-stream"> = {
	id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
	name: "Claude Sonnet 4.5 (US)",
	api: "bedrock-converse-stream",
	provider: "amazon-bedrock",
	baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200000,
	maxTokens: 8192,
};

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		model: claudeModel.id,
		usage,
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

async function capturePayload(messages: Message[], cacheRetention: CacheRetention = "none"): Promise<WirePayload> {
	let captured: WirePayload | undefined;
	const events = streamBedrock(claudeModel, normalizeContext({ systemPrompt: "You are helpful.", messages }), {
		cacheRetention,
		signal: AbortSignal.abort(),
		onPayload: (payload) => {
			captured = payload as WirePayload;
			return payload;
		},
	});
	for await (const event of events) {
		if (event.type === "error") break;
	}
	if (!captured) throw new Error("Expected the Bedrock payload to be captured before the aborted send");
	return captured;
}

describe("Bedrock role alternation (#2114)", () => {
	it("folds the environment-context user message and the prompt into one user message", async () => {
		const payload = await capturePayload([
			{ role: "user", content: "<environment_context>cwd: /repo</environment_context>", timestamp: Date.now() },
			{
				role: "user",
				content: [
					{ type: "text", text: "Fix the bug" },
					{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
				],
				timestamp: Date.now(),
			},
		]);

		expect(payload.messages.map((message) => message.role)).toEqual(["user"]);
		const content = payload.messages[0].content;
		expect(content).toHaveLength(3);
		expect(content[0]).toEqual({ text: "<environment_context>cwd: /repo</environment_context>" });
		expect(content[1]).toEqual({ text: "Fix the bug" });
		expect(content[2]).toHaveProperty("image");
	});

	it("folds a user prompt that follows tool results into the tool-result user message", async () => {
		const payload = await capturePayload([
			{ role: "user", content: "Read both files", timestamp: Date.now() },
			assistant([
				{ type: "toolCall", id: "tool-a", name: "read", arguments: { path: "a.txt" } },
				{ type: "toolCall", id: "tool-b", name: "read", arguments: { path: "b.txt" } },
			]),
			{
				role: "toolResult",
				toolCallId: "tool-a",
				toolName: "read",
				content: [{ type: "text", text: "alpha" }],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "tool-b",
				toolName: "read",
				content: [{ type: "text", text: "beta" }],
				isError: false,
				timestamp: Date.now(),
			},
			{
				role: "user",
				content: "<environment_context>date: 2026-09-24</environment_context>",
				timestamp: Date.now(),
			},
			{ role: "user", content: "Now summarize them", timestamp: Date.now() },
		]);

		expect(payload.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
		const last = payload.messages[2].content;
		expect(last.map((block) => block.toolResult?.toolUseId ?? block.text)).toEqual([
			"tool-a",
			"tool-b",
			"<environment_context>date: 2026-09-24</environment_context>",
			"Now summarize them",
		]);
	});

	it("keeps the cache point at the end of the merged last user message", async () => {
		const payload = await capturePayload(
			[
				{ role: "user", content: "<environment_context>cwd: /repo</environment_context>", timestamp: Date.now() },
				{ role: "user", content: "Fix the bug", timestamp: Date.now() },
			],
			"short",
		);

		expect(payload.messages).toHaveLength(1);
		const content = payload.messages[0].content;
		expect(content.map((block) => (block.cachePoint ? "cachePoint" : block.text))).toEqual([
			"<environment_context>cwd: /repo</environment_context>",
			"Fix the bug",
			"cachePoint",
		]);
	});

	it("leaves an already alternating conversation unchanged", async () => {
		const payload = await capturePayload([
			{ role: "user", content: "Hi", timestamp: Date.now() },
			assistant([{ type: "text", text: "Hello" }]),
			{ role: "user", content: "Bye", timestamp: Date.now() },
		]);

		expect(payload.messages).toEqual([
			{ role: "user", content: [{ text: "Hi" }] },
			{ role: "assistant", content: [{ text: "Hello" }] },
			{ role: "user", content: [{ text: "Bye" }] },
		]);
	});
});
