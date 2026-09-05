import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { Message, Model } from "../src/types.ts";

describe("OpenAI mid-session configuration updates", () => {
	it("places the update immediately before the next user message", () => {
		const model = {
			id: "gpt-6-astra",
			provider: "openai",
			api: "openai-responses",
			reasoning: true,
			input: ["text"],
		} as Model<"openai-responses">;
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-6-astra",
				usage: {} as any,
				stopReason: "stop",
				timestamp: 1,
			},
			{ role: "configurationUpdate", content: [], effort: "high", timestamp: 2 },
			{ role: "user", content: "next", timestamp: 3 },
		];
		expect(convertResponsesMessages(model, { systemPrompt: "", messages, tools: [] }, new Set())).toMatchObject([
			{ role: "assistant" },
			{ type: "configuration_update", reasoning: { effort: "high" } },
			{ role: "user" },
		]);
	});

	it("replaces an adjacent update rather than adding another", () => {
		const model = {
			id: "gpt-6-astra",
			provider: "openai-codex",
			api: "openai-codex-responses",
			reasoning: true,
			input: ["text"],
		} as Model<"openai-codex-responses">;
		const messages: Message[] = [
			{ role: "configurationUpdate", content: [], effort: "low", timestamp: 1 },
			{ role: "configurationUpdate", content: [], effort: "high", timestamp: 2 },
			{ role: "user", content: "next", timestamp: 3 },
		];
		expect(convertResponsesMessages(model, { systemPrompt: "", messages, tools: [] }, new Set())).toMatchObject([
			{ type: "configuration_update", reasoning: { effort: "high" } },
			{ role: "user" },
		]);
	});

	it("does not update unsupported models or providers", () => {
		const messages: Message[] = [{ role: "configurationUpdate", content: [], effort: "high", timestamp: 1 }];
		const input = (model: Model<any>) =>
			convertResponsesMessages(model, { systemPrompt: "", messages, tools: [] }, new Set());
		expect(
			input({ id: "gpt-5", provider: "openai", api: "openai-responses", input: ["text"] } as Model<any>),
		).toEqual([]);
		expect(
			input({ id: "gpt-6-astra", provider: "opencode", api: "openai-responses", input: ["text"] } as Model<any>),
		).toEqual([]);
	});
});
