import { describe, expect, it } from "vitest";
import { parseOpenGatewayPriceTable } from "../src/providers/opengateway-catalog.ts";
import livePrices from "./fixtures/opengateway-prices-20261023.json" with { type: "json" };

// Trimmed from the public feed on 2026-10-23; retain route identity and billing fields only.
describe("OpenGateway public price table", () => {
	it.each([
		["envelope", livePrices],
		["legacy flat table", livePrices.entries],
	])("scales effective prices and context tiers from the %s", (_shape, value) => {
		const routes = parseOpenGatewayPriceTable(value);

		expect(routes).toHaveLength(5);
		expect(routes.find((route) => route.modelId === "deepseek/deepseek-v4-flash")?.price).toEqual({
			input: 0.396,
			output: 1.188,
			cacheRead: 0.0126,
			cacheWrite: 0,
			tiers: [],
		});
		expect(routes.find((route) => route.modelId === "qwen/qwen-flash")?.price).toEqual({
			input: 0.05,
			output: 0.4,
			cacheRead: undefined,
			cacheWrite: undefined,
			tiers: [{ inputTokensAbove: 256000, input: 0.25, output: 2, cacheRead: 0, cacheWrite: 0 }],
		});
	});

	it.each([
		["currency", "EUR"],
		["unit", "USD_PER_MILLION_TOKENS"],
		["currency", null],
		["unit", null],
	])("refuses unsupported %s metadata (%s)", (field, value) => {
		expect(() => parseOpenGatewayPriceTable({ ...livePrices, [field]: value })).toThrow(
			new RegExp(`OpenGateway price table.*${field}`),
		);
	});

	it("accepts an envelope without optional billing metadata", () => {
		expect(parseOpenGatewayPriceTable({ entries: livePrices.entries })).toHaveLength(5);
	});

	it.each([{}, { entries: {} }, { entries: [] }, { entries: null }])(
		"refuses an empty or malformed table",
		(value) => {
			expect(() => parseOpenGatewayPriceTable(value)).toThrow(/OpenGateway price table/);
		},
	);

	it("reads a flat table whose route keys collide with the envelope field names", () => {
		const [first, second, third] = Object.values(livePrices.entries);

		const routes = parseOpenGatewayPriceTable({ entries: first, currency: second, unit: third });

		expect(routes.map((route) => route.modelId)).toEqual(
			[first, second, third].map((entry) => `${entry.modelOwner}/${entry.modelName}`),
		);
	});

	it("skips a malformed route without discarding the other prices", () => {
		const routes = parseOpenGatewayPriceTable({ ...livePrices, entries: { ...livePrices.entries, broken: null } });

		expect(routes).toHaveLength(5);
	});
});
