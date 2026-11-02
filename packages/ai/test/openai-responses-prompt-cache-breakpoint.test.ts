import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { CacheRetention, Context, Model } from "../src/types.ts";

const context: Context = {
	systemPrompt: "You are a stable prefix.",
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

async function firstInputItem(model: Model<"openai-responses">, cacheRetention?: CacheRetention): Promise<unknown> {
	let payload: { input?: unknown[] } | undefined;
	await streamSimple(model, context, {
		apiKey: "test-key",
		...(cacheRetention !== undefined ? { cacheRetention } : {}),
		onPayload: (body) => {
			payload = body as { input?: unknown[] };
			throw new Error("payload captured");
		},
	}).result();
	return payload?.input?.[0];
}

// senpi#2096: with a hosted web_search_preview tool, GPT-5.6+ reads a prewarmed or previous
// prefix only when the system prompt block carries an explicit prompt_cache_breakpoint.
describe("OpenAI Responses system prompt cache breakpoint", () => {
	it("marks the system prompt block with an explicit breakpoint on explicit-cache models", async () => {
		await expect(firstInputItem(getModel("openai", "gpt-6-luna"))).resolves.toEqual({
			role: "developer",
			content: [
				{ type: "input_text", text: "You are a stable prefix.", prompt_cache_breakpoint: { mode: "explicit" } },
			],
		});
		await expect(firstInputItem(getModel("openai", "gpt-6-luna"), "long")).resolves.toMatchObject({
			content: [{ prompt_cache_breakpoint: { mode: "explicit" } }],
		});
	});

	it("keeps the plain string system prompt when caching is off or the model has no explicit mode", async () => {
		await expect(firstInputItem(getModel("openai", "gpt-6-luna"), "none")).resolves.toEqual({
			role: "developer",
			content: "You are a stable prefix.",
		});
		await expect(firstInputItem(getModel("openai", "gpt-5.5"))).resolves.toMatchObject({
			content: "You are a stable prefix.",
		});
	});
});
