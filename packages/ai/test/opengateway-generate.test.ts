import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenGatewayModels } from "../scripts/generate-models-opengateway.ts";
import { GATEWAY_URL, gatewayResponse, PRICES_URL, priceTable } from "./opengateway-fixtures.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";

function modelsDevResponse(providers: Record<string, Record<string, object>>) {
	return Object.fromEntries(Object.entries(providers).map(([key, models]) => [key, { models }]));
}

const UNRELATED_PRICES = priceTable({ "acme/unrelated-model": { input: 1, output: 1 } });

function stubFetch(gateway: unknown, modelsDev: unknown, prices: unknown = UNRELATED_PRICES) {
	vi.stubGlobal("fetch", async (url: string | URL) => {
		const href = String(url);
		const payload =
			href === GATEWAY_URL
				? gateway
				: href === MODELS_DEV_URL
					? modelsDev
					: href === PRICES_URL
						? prices
						: undefined;
		if (!payload) throw new Error(`unexpected fetch: ${href}`);
		return { ok: true, status: 200, json: async () => payload } as Response;
	});
}

const KIMI_K3_SOURCE = {
	name: "Kimi K3",
	tool_call: true,
	reasoning: true,
	limit: { context: 1048576, output: 131072 },
	cost: { input: 3, output: 15, cache_read: 0.3 },
};

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fetchOpenGatewayModels", () => {
	it("admits a model the gateway newly serves, sized and priced by the gateway", async () => {
		stubFetch(
			gatewayResponse([
				{
					id: "anthropic/claude-opus-6",
					input: ["text", "image"],
					context_window: 500000,
					max_output_tokens: 64000,
				},
			]),
			modelsDevResponse({
				anthropic: {
					"claude-opus-6": {
						name: "Claude Opus 6",
						tool_call: true,
						reasoning: true,
						limit: { context: 1000000, output: 128000 },
						cost: { input: 9, output: 45, cache_read: 0.9, cache_write: 11 },
					},
				},
			}),
			priceTable({ "anthropic/claude-opus-6": { input: 5, output: 25, cacheRead: 0.5 } }),
		);

		const [model] = await fetchOpenGatewayModels(() => {}, { strict: true });

		expect(model).toMatchObject({
			id: "anthropic/claude-opus-6",
			name: "Claude Opus 6",
			provider: "opengateway",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 500000,
			maxTokens: 64000,
			// cacheWrite is not published by the gateway route, so models.dev fills it.
			cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 11 },
		});
	});

	it("bills from the model's preferred route and keeps the route's long-context tier", async () => {
		stubFetch(
			gatewayResponse([{ id: "openai/gpt-6-astra", routes: ["azure", "openai"] }]),
			modelsDevResponse({
				openai: {
					"gpt-6-astra": { name: "GPT-6 Astra", tool_call: true, limit: { context: 1050000, output: 128000 } },
				},
			}),
			{
				...priceTable({ "openai/gpt-6-astra": { route: "openai", input: 99, output: 99 } }),
				...priceTable({
					"openai/gpt-6-astra": {
						route: "azure",
						input: 10,
						output: 50,
						cacheRead: 1,
						tiers: { 272000: { input: 20, output: 75, cacheRead: 2, cacheCreation: null } },
					},
				}),
			},
		);

		const [model] = await fetchOpenGatewayModels(() => {}, { strict: true });

		expect(model?.cost).toEqual({
			input: 10,
			output: 50,
			cacheRead: 1,
			cacheWrite: 0,
			tiers: [{ inputTokensAbove: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 0 }],
		});
	});

	it("enriches a serving-tier variant from its base model when models.dev has no row for it", async () => {
		stubFetch(
			gatewayResponse([{ id: "moonshotai/kimi-k4-ultrafast", context_window: 262144, max_output_tokens: 20480 }]),
			modelsDevResponse({ moonshotai: { "kimi-k4": { ...KIMI_K3_SOURCE, name: "Kimi K4" } } }),
			priceTable({ "moonshotai/kimi-k4-ultrafast": { input: 6, output: 30, cacheRead: 0.6 } }),
		);

		const models = await fetchOpenGatewayModels(() => {}, { strict: true });

		expect(models).toEqual([
			expect.objectContaining({
				id: "moonshotai/kimi-k4-ultrafast",
				name: "Kimi K4 Ultrafast",
				reasoning: true,
				contextWindow: 262144,
				maxTokens: 20480,
				cost: { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 0 },
			}),
		]);
	});

	it("drops models the gateway no longer lists or has retired", async () => {
		stubFetch(
			gatewayResponse([{ id: "moonshotai/kimi-k3" }, { id: "openai/o1-preview", status: "retired" }]),
			modelsDevResponse({
				moonshotai: { "kimi-k3": KIMI_K3_SOURCE },
				openai: {
					"o1-preview": { name: "o1 preview", tool_call: true, limit: { context: 128000, output: 32768 } },
				},
			}),
		);

		const models = await fetchOpenGatewayModels(() => {}, { strict: true });

		expect(models.map((model) => model.id)).toEqual(["moonshotai/kimi-k3"]);
	});

	// Folded from a parallel OpenGateway refresh branch: one broken third-party row must not sink the refresh.
	it("drops only the model whose models.dev entry is malformed", async () => {
		stubFetch(
			gatewayResponse([{ id: "z-ai/glm-good" }, { id: "z-ai/glm-broken" }]),
			modelsDevResponse({
				zai: {
					"glm-good": { name: "GLM Good", tool_call: true, limit: { context: 200000, output: 32000 } },
					"glm-broken": { name: "GLM Broken", tool_call: true, limit: { context: "huge" } },
				},
			}),
		);

		const models = await fetchOpenGatewayModels(() => {}, { strict: true });

		expect(models.map((model) => model.id)).toEqual(["z-ai/glm-good"]);
	});

	it("skips non-chat, unenrichable, and tool-incapable models", async () => {
		stubFetch(
			gatewayResponse([
				{ id: "openai/gpt-5" },
				{ id: "openai/gpt-image-2", endpoints: ["images_generations"] },
				{ id: "acme/mystery-model" },
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

	it("keeps models.dev limits and context tiers when the gateway publishes neither", async () => {
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

		const [model] = await fetchOpenGatewayModels(() => {}, { strict: true });

		expect(model).toMatchObject({ contextWindow: 1100000, maxTokens: 128000 });
		expect(model?.cost.tiers).toEqual([
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

	describe("when the gateway cannot be reached", () => {
		function lastGoodCatalog(): string {
			const dir = mkdtempSync(join(tmpdir(), "opengateway-last-good-"));
			tempDirs.push(dir);
			const path = join(dir, "opengateway.json");
			const kimi = { id: "moonshotai/kimi-k3", name: "Kimi K3", api: "openai-completions", provider: "opengateway" };
			writeFileSync(path, JSON.stringify({ "openai-completions": { "chat:moonshotai/kimi-k3": kimi } }));
			return path;
		}

		it("keeps shipping the last good catalog instead of an empty provider", async () => {
			vi.stubGlobal("fetch", async () => ({ ok: false, status: 503 }) as Response);

			const models = await fetchOpenGatewayModels(() => {}, {
				strict: false,
				lastGoodCatalogPath: lastGoodCatalog(),
			});

			expect(models.map((model) => model.id)).toEqual(["moonshotai/kimi-k3"]);
		});

		it("keeps the last good catalog when only the price table is unavailable", async () => {
			vi.stubGlobal("fetch", async (url: string | URL) =>
				String(url) === PRICES_URL
					? ({ ok: false, status: 502 } as Response)
					: ({ ok: true, status: 200, json: async () => gatewayResponse([{ id: "openai/gpt-5" }]) } as Response),
			);

			const models = await fetchOpenGatewayModels(() => {}, {
				strict: false,
				lastGoodCatalogPath: lastGoodCatalog(),
			});

			expect(models.map((model) => model.id)).toEqual(["moonshotai/kimi-k3"]);
		});

		it("fails a strict regeneration so the outage is visible", async () => {
			vi.stubGlobal("fetch", async () => ({ ok: false, status: 503 }) as Response);

			await expect(fetchOpenGatewayModels(() => {}, { strict: true })).rejects.toThrow(/returned 503/);
		});
	});
});
