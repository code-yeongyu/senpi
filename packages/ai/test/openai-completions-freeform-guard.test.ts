import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Context, Model, Tool } from "../src/types.js";

describe("openai completions freeform guard", () => {
	it("rejects freeform tools before serializing chat-completions function tools", async () => {
		// given
		const freeformTool: Tool = {
			name: "apply_patch",
			description: "freeform apply_patch",
			parameters: Type.Object({ input: Type.String() }),
			freeform: {
				type: "grammar",
				syntax: "lark",
				definition: "start: /.*/",
			},
		};
		const model: Model<"openai-completions"> = {
			id: "gpt-4o-mini",
			name: "GPT-4o mini",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			input: ["text"],
			reasoning: false,
			contextWindow: 128000,
			maxTokens: 16384,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		const context: Context = {
			messages: [{ role: "user", content: "patch", timestamp: Date.now() }],
			tools: [freeformTool],
		};

		// when
		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			onPayload() {
				throw new Error("freeform guard did not run before payload inspection");
			},
		});
		const result = await stream.result();

		// then
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Freeform tools cannot be sent to OpenAI Chat Completions");
	});
});
