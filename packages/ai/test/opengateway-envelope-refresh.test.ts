import { afterEach, describe, expect, it, vi } from "vitest";
import type { RefreshModelsContext } from "../src/models.ts";
import { createOpenGatewayCatalog } from "../src/providers/opengateway-refresh.ts";
import type { Model } from "../src/types.ts";
import livePrices from "./fixtures/opengateway-prices-20261023.json" with { type: "json" };
import { GATEWAY_URL, gatewayResponse } from "./opengateway-fixtures.ts";

const shipped: Model<"openai-completions"> = {
	id: "acme/retired",
	name: "Retired model",
	api: "openai-completions",
	provider: "opengateway",
	baseUrl: "https://apis.opengateway.ai/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 9, output: 10, cacheRead: 1, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 32000,
};
const listing = gatewayResponse([
	{ id: shipped.id, status: "retired" },
	{ id: "deepseek/deepseek-v4-flash", routes: ["alibaba"], context_window: 1000000 },
]);

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("OpenGateway runtime price envelope", () => {
	it.each([
		["currency", { ...livePrices, currency: "EUR" }],
		["unit", { ...livePrices, unit: "USD_PER_MILLION_TOKENS" }],
		["empty entries", { ...livePrices, entries: {} }],
	])("preserves the last successful refresh on refused %s without persisting it", async (_reason, refused) => {
		const catalog = createOpenGatewayCatalog([shipped], undefined);
		vi.stubGlobal("fetch", async (url: string) => Response.json(url === GATEWAY_URL ? listing : livePrices));
		const publish = vi.fn<RefreshModelsContext["publish"]>(async (publication) => {
			publication.update?.();
			return true;
		});
		const context: RefreshModelsContext = {
			publish,
			allowNetwork: true,
			force: true,
			signal: new AbortController().signal,
		};
		await catalog.refresh(context);
		const lastGood = catalog.getModels();
		expect(lastGood).toEqual([
			expect.objectContaining({
				id: "deepseek/deepseek-v4-flash",
				cost: { input: 0.396, output: 1.188, cacheRead: 0.0126, cacheWrite: 0 },
			}),
		]);
		publish.mockClear();
		// Feed metadata is untrusted; use a new fetch response rather than casting the fixture.
		vi.stubGlobal("fetch", async (url: string) => Response.json(url === GATEWAY_URL ? listing : refused));

		await expect(catalog.refresh(context)).rejects.toThrow(/OpenGateway price table/);

		expect(catalog.getModels()).toBe(lastGood);
		expect(publish).not.toHaveBeenCalled();
	});
});
