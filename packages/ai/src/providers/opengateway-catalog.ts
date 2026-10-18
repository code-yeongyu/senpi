// OpenGateway's public catalog data, shared by the build-time generator
// (scripts/generate-models-opengateway.ts) and the runtime refresh
// (opengateway-refresh.ts). Both endpoints are public and need no API key.
//
// - GET https://apis.opengateway.ai/v1/models lists every model the gateway
//   serves: lifecycle status, modalities, endpoints, the provider routes in
//   preference order, and (for most models) context window and max output.
// - GET https://opengateway.ai/api/model-prices is the price table the
//   gateway bills from, keyed per provider route, with the effective
//   (discounted) per-token price and long-context tiers.

import type { ModelCost, ModelCostTier } from "../types.ts";

export const OPENGATEWAY_BASE_URL = "https://apis.opengateway.ai/v1";
export const OPENGATEWAY_MODELS_URL = `${OPENGATEWAY_BASE_URL}/models`;
export const OPENGATEWAY_PRICES_URL = "https://opengateway.ai/api/model-prices";

const SERVING_TIER_SUFFIXES: readonly { suffix: string; label: string }[] = [
	{ suffix: "-ultrafast", label: "Ultrafast" },
];

export interface OpenGatewayListedModel {
	id: string;
	status?: string;
	inputModalities: readonly string[];
	endpoints: readonly string[];
	/** Provider route ids in the gateway's preference order. */
	routes: readonly string[];
	contextWindow?: number;
	maxOutputTokens?: number;
}

/** Published per-million-token prices; a field is absent when the gateway does not publish it. */
export interface OpenGatewayPrice {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	tiers: ModelCostTier[];
}

interface PriceRoute {
	route: string;
	modelId: string;
	price: OpenGatewayPrice;
}

export type OpenGatewayPriceTable = readonly PriceRoute[];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function parseOpenGatewayListing(value: unknown): OpenGatewayListedModel[] {
	if (!isRecord(value) || !Array.isArray(value.data)) {
		throw new Error("OpenGateway model listing is not a { data: [...] } list");
	}
	const models: OpenGatewayListedModel[] = [];
	for (const entry of value.data) {
		if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.includes("/")) continue;
		const modalities = isRecord(entry.modalities) ? entry.modalities : {};
		const routes = Array.isArray(entry.providers)
			? entry.providers.flatMap((route) => (isRecord(route) && typeof route.id === "string" ? [route.id] : []))
			: [];
		models.push({
			id: entry.id,
			status: typeof entry.status === "string" ? entry.status : undefined,
			inputModalities: stringList(modalities.input),
			endpoints: stringList(entry.endpoints),
			routes,
			contextWindow: positiveInteger(entry.context_window),
			maxOutputTokens: positiveInteger(entry.max_output_tokens),
		});
	}
	if (models.length === 0) throw new Error("OpenGateway model listing has no models");
	return models;
}

/** Chat-completions models that can still be called. Retired models are listed but rejected. */
export function isServableChatModel(model: OpenGatewayListedModel): boolean {
	return model.endpoints.includes("chat_completions") && model.status !== "retired";
}

/** `z-ai/glm-5.3-ultrafast` -> its base `z-ai/glm-5.3` plus the tier label, or undefined. */
export function servingTierBase(id: string): { baseId: string; label: string } | undefined {
	for (const { suffix, label } of SERVING_TIER_SUFFIXES) {
		if (id.endsWith(suffix) && id.length > suffix.length) return { baseId: id.slice(0, -suffix.length), label };
	}
	return undefined;
}

function perMillion(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	// Per-token decimals (2e-7) scale to float noise (0.19999999999999998); 12 significant digits remove it.
	return Number((value * 1_000_000).toPrecision(12));
}

function parseTiers(axisPrices: unknown): ModelCostTier[] {
	if (!isRecord(axisPrices)) return [];
	const tiers: ModelCostTier[] = [];
	for (const [key, value] of Object.entries(axisPrices)) {
		// Keys look like "AxisKey(threshold=272000, tier=null)"; only plain context thresholds are input tiers.
		const match = /^AxisKey\(threshold=(\d+), tier=null\)$/.exec(key);
		if (!match || !isRecord(value) || value.isEmpty === true) continue;
		const input = perMillion(value.input);
		const output = perMillion(value.output);
		if (input === undefined || output === undefined) continue;
		tiers.push({
			inputTokensAbove: Number(match[1]),
			input,
			output,
			cacheRead: perMillion(value.cacheRead) ?? 0,
			cacheWrite: perMillion(value.cacheCreation) ?? 0,
		});
	}
	return tiers.sort((left, right) => left.inputTokensAbove - right.inputTokensAbove);
}

export function parseOpenGatewayPriceTable(value: unknown): OpenGatewayPriceTable {
	if (!isRecord(value)) throw new Error("OpenGateway price table is not an object");
	const routes: PriceRoute[] = [];
	for (const entry of Object.values(value)) {
		if (!isRecord(entry) || typeof entry.provider !== "string") continue;
		if (typeof entry.modelOwner !== "string" || typeof entry.modelName !== "string") continue;
		const pricing = isRecord(entry.pricing) && isRecord(entry.pricing.current) ? entry.pricing.current : undefined;
		// The effective price already carries the gateway's discount; the list price is the fallback.
		const effective = pricing && isRecord(pricing.effectivePrice) ? pricing.effectivePrice : entry;
		routes.push({
			route: entry.provider,
			modelId: `${entry.modelOwner}/${entry.modelName}`,
			price: {
				input: perMillion(effective.inputCostPerToken),
				output: perMillion(effective.outputCostPerToken),
				cacheRead: perMillion(effective.cacheReadInputTokenCost),
				cacheWrite: perMillion(effective.cacheCreationInputTokenCost),
				tiers: parseTiers(effective.axisPrices),
			},
		});
	}
	if (routes.length === 0) throw new Error("OpenGateway price table has no priced routes");
	return routes;
}

/** The price billed for a listed model: its preferred route's price, else any route's. */
export function openGatewayPrice(
	model: OpenGatewayListedModel,
	table: OpenGatewayPriceTable,
): OpenGatewayPrice | undefined {
	const candidates = table.filter((entry) => entry.modelId === model.id);
	for (const route of model.routes) {
		const preferred = candidates.find((entry) => entry.route === route);
		if (preferred) return preferred.price;
	}
	return candidates[0]?.price;
}

/** Overlay published gateway prices on a fallback cost; unpublished fields keep the fallback. */
export function withGatewayPrice(fallback: ModelCost, price: OpenGatewayPrice | undefined): ModelCost {
	if (!price) return fallback;
	const cost: ModelCost = {
		input: price.input ?? fallback.input,
		output: price.output ?? fallback.output,
		cacheRead: price.cacheRead ?? fallback.cacheRead,
		cacheWrite: price.cacheWrite ?? fallback.cacheWrite,
	};
	// A published route price owns its tiers: no gateway tiers means flat billing.
	if (price.input !== undefined && price.output !== undefined) {
		if (price.tiers.length > 0) cost.tiers = price.tiers;
	} else if (fallback.tiers) {
		cost.tiers = fallback.tiers;
	}
	return cost;
}
