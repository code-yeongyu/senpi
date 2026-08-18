import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenGatewayModels } from "../scripts/generate-models-opengateway.ts";

const GATEWAY_URL = "https://apis.opengateway.ai/v1/models";
const MODELS_DEV_URL = "https://models.dev/api.json";

function gatewayResponse(ids: { id: string; status?: string; endpoints?: string[]; input?: string[] }[]) {
	return {
		data: ids.map((item) => ({
			id: item.id,
			object: "model",
			status: item.status ?? "active",
			modalities: { input: item.input ?? ["text"], output: ["text"] },
			endpoints: item.endpoints ?? ["chat_completions"],
		})),
	};
}

function modelsDevResponse(providers: Record<string, Record<string, object>>) {
	return Object.fromEntries(Object.entries(providers).map(([key, models]) => [key, { models }]));
}

function stubFetch(gateway: unknown, modelsDev: unknown) {
	vi.stubGlobal("fetch", async (url: string | URL) => {
		const href = String(url);
		const payload = href === GATEWAY_URL ? gateway : href === MODELS_DEV_URL ? modelsDev : undefined;
		if (!payload) throw new Error(`unexpected fetch: ${href}`);
		return { ok: true, status: 200, json: async () => payload } as Response;
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("fetchOpenGatewayModels", () => {
	it("prefers the owning provider's models.dev catalog over the OpenRouter id space", async () => {
		stubFetch(
			gatewayResponse([{ id: "moonshotai/kimi-k3" }]),
			modelsDevResponse({
				moonshotai: {
					"kimi-k3": {
						name: "Kimi K3",
						tool_call: true,
						reasoning: true,
						limit: { context: 1048576, output: 131072 },
					},
				},
				openrouter: {
					"moonshotai/kimi-k3": {
						name: "K3 via OR",
						tool_call: true,
						limit: { context: 1048576, output: 1048576 },
					},
				},
			}),
		);
		const models = await fetchOpenGatewayModels(() => {}, { strict: true });
		expect(models).toHaveLength(1);
		expect(models[0]?.name).toBe("Kimi K3");
		expect(models[0]?.maxTokens).toBe(131072);
	});

	it("falls back to the OpenRouter id space when the owner catalog lacks the model", async () => {
		stubFetch(
			gatewayResponse([{ id: "x-ai/grok-4.20" }]),
			modelsDevResponse({
				xai: {},
				openrouter: {
					"x-ai/grok-4.20": { name: "Grok 4.20", tool_call: true, limit: { context: 2000000, output: 128000 } },
				},
			}),
		);
		const models = await fetchOpenGatewayModels(() => {}, { strict: true });
		expect(models).toHaveLength(1);
		expect(models[0]?.name).toBe("Grok 4.20");
		expect(models[0]?.contextWindow).toBe(2000000);
	});

	it("applies explicit overrides for models models.dev cannot enrich", async () => {
		stubFetch(gatewayResponse([{ id: "moonshotai/kimi-k3-ultrafast" }]), modelsDevResponse({}));
		const models = await fetchOpenGatewayModels(() => {}, { strict: true });
		expect(models).toHaveLength(1);
		expect(models[0]?.name).toBe("Kimi K3 Ultrafast");
		expect(models[0]?.reasoning).toBe(true);
		expect(models[0]?.maxTokens).toBe(131072);
	});

	it("skips retired, non-chat, unenrichable, and tool-incapable models", async () => {
		stubFetch(
			gatewayResponse([
				{ id: "openai/gpt-5" },
				{ id: "openai/o1-preview", status: "retired" },
				{ id: "openai/gpt-image-2", endpoints: ["images_generations"] },
				{ id: "sionic-ai/mystery-model" },
				{ id: "openai/gpt-3.5-turbo" },
			]),
			modelsDevResponse({
				openai: {
					"gpt-5": { name: "GPT-5", tool_call: true, limit: { context: 400000, output: 128000 } },
					"gpt-3.5-turbo": { name: "GPT-3.5", tool_call: false, limit: { context: 16385, output: 4096 } },
				},
			}),
		);
		const models = await fetchOpenGatewayModels(() => {}, { strict: true });
		expect(models.map((model) => model.id)).toEqual(["openai/gpt-5"]);
	});

	it("preserves models.dev context-tier pricing in ModelCost", async () => {
		stubFetch(
			gatewayResponse([{ id: "openai/gpt-5.6" }]),
			modelsDevResponse({
				openai: {
					"gpt-5.6": {
						name: "GPT-5.6",
						tool_call: true,
						limit: { context: 1100000, output: 128000 },
						cost: {
							input: 2,
							output: 12,
							tiers: [{ input: 4, output: 24, cache_read: 0.4, tier: { type: "context", size: 272000 } }],
						},
					},
				},
			}),
		);
		const models = await fetchOpenGatewayModels(() => {}, { strict: true });
		expect(models[0]?.cost.tiers).toEqual([
			{ inputTokensAbove: 272000, input: 4, output: 24, cacheRead: 0.4, cacheWrite: 0 },
		]);
	});

	it("records reasoning options for the thinking-level-map pipeline", async () => {
		stubFetch(
			gatewayResponse([{ id: "openai/gpt-5" }]),
			modelsDevResponse({
				openai: {
					"gpt-5": {
						name: "GPT-5",
						tool_call: true,
						reasoning: true,
						reasoning_options: [{ type: "effort", values: ["low", "high"] }],
						limit: { context: 400000, output: 128000 },
					},
				},
			}),
		);
		const recorded: string[] = [];
		await fetchOpenGatewayModels((id) => recorded.push(id), { strict: true });
		expect(recorded).toEqual(["openai/gpt-5"]);
	});

	it("throws on fetch failure in strict mode and returns empty otherwise", async () => {
		vi.stubGlobal("fetch", async () => ({ ok: false, status: 503 }) as Response);
		await expect(fetchOpenGatewayModels(() => {}, { strict: true })).rejects.toThrow("OpenGateway API returned 503");
		await expect(fetchOpenGatewayModels(() => {}, { strict: false })).resolves.toEqual([]);
	});
});
