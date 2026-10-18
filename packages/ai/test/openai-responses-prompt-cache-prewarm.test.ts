import { afterEach, describe, expect, it, vi } from "vitest";
import { warmPromptCache } from "../src/api/warm-prompt-cache.ts";
import { getModel, streamSimple } from "../src/compat.ts";
import type { Context, Model } from "../src/types.ts";

const context: Context = {
	systemPrompt: "You are a stable prefix.",
	messages: [{ role: "user", content: "this turn must not be prewarmed", timestamp: 1 }],
	tools: [
		{
			name: "lookup",
			description: "Look something up",
			parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		},
	],
};

function completedWarmResponse(serviceTier = "default"): Response {
	return new Response(
		JSON.stringify({
			id: "resp_prewarm",
			object: "response",
			created_at: 1,
			status: "completed",
			model: "gpt-6-luna",
			output: [],
			service_tier: serviceTier,
			usage: {
				input_tokens: 5170,
				input_tokens_details: { cached_tokens: 0, cache_write_tokens: 5169 },
				output_tokens: 0,
				output_tokens_details: { reasoning_tokens: 0 },
				total_tokens: 5170,
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function captureFetch(serviceTier?: string) {
	const bodies: Record<string, unknown>[] = [];
	const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return completedWarmResponse(serviceTier);
	});
	return { fetch, bodies };
}

// senpi#2096: prewarm the GPT-5.6+ stable prefix with prompt_cache_options.prewarm.
describe("warmPromptCache for OpenAI Responses GPT-5.6+", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends only the stable prefix with prompt_cache_options.prewarm and parses cache-write usage", async () => {
		const model = getModel("openai", "gpt-6-luna");
		const { fetch, bodies } = captureFetch();
		const result = await warmPromptCache(model, context, { apiKey: "test-key", fetch, reasoning: "high" });

		expect(fetch).toHaveBeenCalledOnce();
		const body = bodies[0];
		expect(body).toMatchObject({ model: "gpt-6-luna", stream: false, store: false });
		expect(body?.prompt_cache_options).toEqual({ prewarm: true });
		expect(body).not.toHaveProperty("prompt_cache_key");
		expect(body?.reasoning).toMatchObject({ effort: "high" });
		const input = body?.input as Array<{ role?: string }>;
		expect(input).toHaveLength(1);
		expect(["developer", "system"]).toContain(input[0]?.role);
		expect(JSON.stringify(input)).toContain("You are a stable prefix.");
		expect(JSON.stringify(input)).not.toContain("this turn must not be prewarmed");
		expect((body?.tools as Array<{ name: string }> | undefined)?.map((tool) => tool.name)).toEqual(["lookup"]);

		expect(result.supported).toBe(true);
		if (!result.supported) return;
		expect(result.usage).toMatchObject({ input: 1, output: 0, cacheRead: 0, cacheWrite: 5169 });
		expect(result.usage.cost?.cacheWrite).toBeCloseTo((5169 * model.cost.cacheWrite) / 1_000_000, 12);
	});

	it("sends the next turn's instructions, tools, reasoning, tier, and cache options unchanged", async () => {
		const model = getModel("openai", "gpt-6-luna");
		const options = {
			apiKey: "test-key",
			reasoning: "high",
			serviceTier: "priority",
			cacheRetention: "long",
			sessionId: "session-2096",
		} as const;
		let turnPayload: Record<string, unknown> | undefined;
		await streamSimple(model, context, {
			...options,
			onPayload: (payload) => {
				turnPayload = payload as Record<string, unknown>;
				throw new Error("turn payload captured");
			},
		}).result();
		const { fetch, bodies } = captureFetch("priority");
		await warmPromptCache(model, context, { ...options, fetch });

		const warm = bodies[0];
		const turnInput = turnPayload?.input as unknown[] | undefined;
		expect(turnInput).toHaveLength(2);
		expect(warm?.input).toEqual(turnInput?.slice(0, 1));
		for (const field of ["model", "instructions", "tools", "reasoning", "text", "service_tier", "include", "store"]) {
			expect(warm?.[field], field).toEqual(turnPayload?.[field]);
		}
		expect(warm?.prompt_cache_options).toEqual({ ...(turnPayload?.prompt_cache_options as object), prewarm: true });
	});

	it("keeps the long-retention ttl and the next turn's service tier on the prewarm request", async () => {
		const model = getModel("openai", "gpt-6-luna");
		const { fetch, bodies } = captureFetch("priority");
		const result = await warmPromptCache(model, context, {
			apiKey: "test-key",
			fetch,
			cacheRetention: "long",
			serviceTier: "priority",
		});

		expect(bodies[0]?.prompt_cache_options).toEqual({ ttl: "30m", prewarm: true });
		expect(bodies[0]?.service_tier).toBe("priority");
		expect(result.supported).toBe(true);
		if (!result.supported) return;
		expect(result.usage.cost?.cacheWrite).toBeCloseTo((2 * 5169 * model.cost.cacheWrite) / 1_000_000, 12);
	});

	it("does not send a request when cacheRetention is none or the endpoint is not api.openai.com", async () => {
		const model = getModel("openai", "gpt-6-luna");
		const proxy: Model<"openai-responses"> = { ...model, baseUrl: "https://proxy.example.com/v1" };
		const { fetch } = captureFetch();

		await expect(
			warmPromptCache(model, context, { apiKey: "test-key", fetch, cacheRetention: "none" }),
		).resolves.toEqual({ supported: false });
		await expect(warmPromptCache(proxy, context, { apiKey: "test-key", fetch })).resolves.toEqual({
			supported: false,
		});
		await expect(
			warmPromptCache(getModel("openai", "gpt-5.5"), context, { apiKey: "test-key", fetch }),
		).resolves.toEqual({ supported: false });
		expect(fetch).not.toHaveBeenCalled();
	});
});
