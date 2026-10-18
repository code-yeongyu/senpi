import { describe, expect, it } from "vitest";
import { convertMessages } from "../src/api/google-shared.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Regression for #2114: Gemini expects user and model turns to alternate, so adjacent same-role turns are folded.

const model: Model<"google-generative-ai"> = {
	id: "gemini-3-pro-preview",
	name: "Gemini 3 Pro Preview",
	api: "google-generative-ai",
	provider: "google",
	baseUrl: "https://generativelanguage.googleapis.com",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000000,
	maxTokens: 8192,
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: Date.now(),
	};
}

describe("google-shared role alternation (#2114)", () => {
	it("folds the environment-context user message and the prompt into one user turn", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "<environment_context>cwd: /repo</environment_context>", timestamp: Date.now() },
				{
					role: "user",
					content: [
						{ type: "text", text: "Fix the bug" },
						{ type: "image", mimeType: "image/png", data: "aGVsbG8=" },
					],
					timestamp: Date.now(),
				},
			],
		};

		const contents = convertMessages(model, normalizeContext(context));

		expect(contents).toEqual([
			{
				role: "user",
				parts: [
					{ text: "<environment_context>cwd: /repo</environment_context>" },
					{ text: "Fix the bug" },
					{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
				],
			},
		]);
	});

	it("folds a user prompt that follows tool results into the function-response turn", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Read the file", timestamp: Date.now() },
				assistant([{ type: "toolCall", id: "call_a", name: "read", arguments: { path: "a.txt" } }]),
				{
					role: "toolResult",
					toolCallId: "call_a",
					toolName: "read",
					content: [{ type: "text", text: "alpha" }],
					isError: false,
					timestamp: Date.now(),
				},
				{ role: "user", content: "Now summarize it", timestamp: Date.now() },
			],
		};

		const contents = convertMessages(model, normalizeContext(context));

		expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
		const parts = contents[2].parts ?? [];
		expect(parts).toHaveLength(2);
		expect(parts[0]?.functionResponse?.response).toEqual({ output: "alpha" });
		expect(parts[1]).toEqual({ text: "Now summarize it" });
	});

	it("leaves an already alternating conversation unchanged", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Hi", timestamp: Date.now() },
				assistant([{ type: "text", text: "Hello" }]),
				{ role: "user", content: "Bye", timestamp: Date.now() },
			],
		};

		const contents = convertMessages(model, normalizeContext(context));

		expect(contents).toEqual([
			{ role: "user", parts: [{ text: "Hi" }] },
			{ role: "model", parts: [{ text: "Hello" }] },
			{ role: "user", parts: [{ text: "Bye" }] },
		]);
	});
});
