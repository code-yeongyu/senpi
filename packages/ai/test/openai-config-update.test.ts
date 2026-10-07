import { describe, expect, it } from "vitest";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import { getModels, supportsConfigurationUpdate } from "../src/compat.ts";
import type { Message, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

function catalogModel(provider: "openai" | "chatgpt-subscription", id: string): Model<any> {
	const model = getModels(provider).find((candidate) => candidate.id === id);
	if (!model) throw new Error(`Missing catalog model ${provider}/${id}`);
	return model;
}

function convert(model: Model<any>, messages: Message[]) {
	return convertResponsesMessages(model, normalizeContext({ systemPrompt: "", messages, tools: [] }), new Set());
}

const updateThenUser: Message[] = [
	{ role: "configurationUpdate", content: [], effort: "high", timestamp: 1 },
	{ role: "user", content: "next", timestamp: 2 },
];

describe("OpenAI mid-session configuration updates", () => {
	it("places the update immediately before the next user message", () => {
		const model = catalogModel("openai", "gpt-6-astra");
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
		expect(convert(model, messages)).toMatchObject([
			{ role: "assistant" },
			{ type: "configuration_update", reasoning: { effort: "high" } },
			{ role: "user" },
		]);
	});

	it("replaces an adjacent update rather than adding another", () => {
		const model = catalogModel("chatgpt-subscription", "gpt-6-astra");
		const messages: Message[] = [
			{ role: "configurationUpdate", content: [], effort: "low", timestamp: 1 },
			{ role: "configurationUpdate", content: [], effort: "high", timestamp: 2 },
			{ role: "user", content: "next", timestamp: 3 },
		];
		expect(convert(model, messages)).toMatchObject([
			{ type: "configuration_update", reasoning: { effort: "high" } },
			{ role: "user" },
		]);
	});

	// senpi#2094: the catalog flag, not the gpt-6-astra id, decides who gets the item.
	it.each([
		["openai", "gpt-6-luna"],
		["openai", "gpt-6-luna-fast"],
		["openai", "gpt-5.6-luna"],
		["openai", "gpt-6-sol"],
		["openai", "gpt-6.1-sol"],
		["chatgpt-subscription", "gpt-6-astra-fast"],
		["chatgpt-subscription", "gpt-6.1-sol"],
		["chatgpt-subscription", "gpt-6.1-sol-fast"],
	] as const)("emits the update for flagged %s/%s", (provider, id) => {
		expect(convert(catalogModel(provider, id), updateThenUser)).toMatchObject([
			{ type: "configuration_update", reasoning: { effort: "high" } },
			{ role: "user" },
		]);
	});

	it.each([
		["openai", "gpt-5.5"],
		["chatgpt-subscription", "gpt-6-sol"],
		["chatgpt-subscription", "gpt-5.6-luna"],
	] as const)("keeps the top-level effort path for unflagged %s/%s", (provider, id) => {
		expect(convert(catalogModel(provider, id), updateThenUser)).toMatchObject([{ role: "user" }]);
	});

	it("does not update unsupported models or providers", () => {
		const messages: Message[] = [{ role: "configurationUpdate", content: [], effort: "high", timestamp: 1 }];
		expect(
			convert({ id: "gpt-5", provider: "openai", api: "openai-responses", input: ["text"] } as Model<any>, messages),
		).toEqual([]);
		expect(
			convert(
				{ id: "gpt-6-astra", provider: "opencode", api: "openai-responses", input: ["text"] } as Model<any>,
				messages,
			),
		).toEqual([]);
	});

	it("ignores the flag on APIs that cannot carry the item", () => {
		const model = {
			id: "gpt-6-luna",
			provider: "openrouter",
			api: "openai-completions",
			input: ["text"],
			compat: { supportsConfigurationUpdate: true },
		} as unknown as Model<any>;
		expect(supportsConfigurationUpdate(model)).toBe(false);
	});
});

// senpi#2094: the direct API accepts the item on the GPT-5.6+ family that prices cache writes;
// the Codex backend was verified on gpt-6-astra, and gpt-6.1-sol carries codex's own
// `supports_reasoning_effort_updates` flag (senpi#2390).
describe("configuration_update catalog flag", () => {
	it("flags exactly the openai rows that accept prompt_cache_options", () => {
		for (const model of getModels("openai")) {
			const compat = model.compat as { supportsExplicitPromptCacheMode?: boolean } | undefined;
			expect(supportsConfigurationUpdate(model), model.id).toBe(compat?.supportsExplicitPromptCacheMode === true);
		}
	});

	it("flags only gpt-6-astra, gpt-6.1-sol and their -fast variants on the ChatGPT subscription", () => {
		const flagged = getModels("chatgpt-subscription")
			.filter((model) => supportsConfigurationUpdate(model))
			.map((model) => model.id)
			.sort();
		expect(flagged).toEqual(["gpt-6-astra", "gpt-6-astra-fast", "gpt-6.1-sol", "gpt-6.1-sol-fast"]);
	});
});
