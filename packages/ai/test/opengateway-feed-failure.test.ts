import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenGatewayModels, loadLastGoodOpenGatewayModels } from "../scripts/generate-models-opengateway.ts";
import livePrices from "./fixtures/opengateway-prices-20261023.json" with { type: "json" };
import { GATEWAY_URL, gatewayResponse, PRICES_URL } from "./opengateway-fixtures.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const REFUSED_FEEDS = [
	["currency", { ...livePrices, currency: "EUR" }],
	["unit", { ...livePrices, unit: "USD_PER_MILLION_TOKENS" }],
	["empty prices", { ...livePrices, entries: {} }],
	["malformed prices", { entries: null }],
] as const;

describe("OpenGateway generation feed refusal", () => {
	it.each(REFUSED_FEEDS)("fails the strict refresh run after refused %s", async (_reason, prices) => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.stubGlobal("fetch", async (url: string) =>
			Response.json(url === PRICES_URL ? prices : gatewayResponse([{ id: "acme/new" }])),
		);

		await expect(fetchOpenGatewayModels(() => {}, { strict: true })).rejects.toThrow(/OpenGateway price table/);
	});

	it.each(REFUSED_FEEDS)(
		"keeps the committed catalog in an opted-in strict run after refused %s",
		async (_reason, prices) => {
			const expected = loadLastGoodOpenGatewayModels();
			const refusal = vi.spyOn(console, "error").mockImplementation(() => {});
			const retained = vi.spyOn(console, "warn").mockImplementation(() => {});
			vi.stubGlobal("fetch", async (url: string) =>
				Response.json(url === PRICES_URL ? prices : gatewayResponse([{ id: "acme/new" }])),
			);

			const models = await fetchOpenGatewayModels(() => {}, { strict: true, keepLastGoodOnFailure: true });

			expect(expected.length).toBeGreaterThan(0);
			expect(models).toEqual(expected);
			expect(refusal).toHaveBeenCalledWith("Failed to fetch OpenGateway models:", expect.any(Error));
			expect(retained).toHaveBeenCalledOnce();
		},
	);

	it.each([
		["retired listing", gatewayResponse([{ id: "acme/retired", status: "retired" }])],
		["unenrichable listing", gatewayResponse([{ id: "acme/unknown" }])],
	])("keeps the catalog instead of publishing no models after an %s", async (_reason, listing) => {
		const expected = loadLastGoodOpenGatewayModels();
		vi.stubGlobal("fetch", async (url: string) =>
			Response.json(url === GATEWAY_URL ? listing : url === PRICES_URL ? livePrices : {}),
		);

		const models = await fetchOpenGatewayModels(() => {}, { strict: true, keepLastGoodOnFailure: true });

		expect(models).toEqual(expected);
	});

	it("refuses an empty last-good catalog rather than publishing an empty provider", async () => {
		const dir = mkdtempSync(join(tmpdir(), "opengateway-empty-"));
		const path = join(dir, "opengateway.json");
		writeFileSync(path, "{}");
		vi.stubGlobal("fetch", async () => new Response("unavailable", { status: 503 }));

		try {
			await expect(
				fetchOpenGatewayModels(() => {}, { strict: true, keepLastGoodOnFailure: true, lastGoodCatalogPath: path }),
			).rejects.toThrow(/Last good OpenGateway catalog has no models/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
