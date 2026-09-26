import { describe, expect, it } from "vitest";
import { convertMessages, getCompat } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

function createModel(baseUrl: string): Model<"openai-completions"> {
	const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
	return {
		...(baseModel as Omit<Model<"openai-completions">, "api">),
		api: "openai-completions",
		baseUrl,
	};
}

function convert(baseUrl: string) {
	const model = createModel(baseUrl);
	const context: Context = {
		systemPrompt: "system",
		messages: [
			{ role: "user", content: "prompt", timestamp: 1 },
			{ role: "user", content: "extension message", timestamp: 2 },
		],
	};

	return convertMessages(model, context, getCompat(model));
}

describe("openai-completions message ordering", () => {
	it("folds adjacent user messages for non-OpenAI hosts", () => {
		const messages = convert("https://llama.example/v1");

		expect(messages).toEqual([
			{ role: "system", content: "system" },
			{
				role: "user",
				content: [
					{ type: "text", text: "prompt" },
					{ type: "text", text: "extension message" },
				],
			},
		]);
	});

	it("preserves adjacent user messages for api.openai.com", () => {
		const messages = convert("https://api.openai.com/v1");

		expect(messages).toEqual([
			{ role: "system", content: "system" },
			{ role: "user", content: "prompt" },
			{ role: "user", content: "extension message" },
		]);
	});
});
