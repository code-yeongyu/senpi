// OpenGateway catalog fetch + enrichment for generate-models.ts.
//
// The gateway is authoritative for what it serves: availability, modalities,
// context window, max output (GET /v1/models) and the per-token price it bills
// (its public price table). models.dev supplies what the gateway does not
// publish: display names, tool and reasoning capability, reasoning options,
// and limits or prices for models whose gateway row omits them. The owning
// provider's models.dev catalog is preferred; the OpenRouter id space is the
// fallback.

import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
	isServableChatModel,
	OPENGATEWAY_BASE_URL,
	OPENGATEWAY_MODELS_URL,
	OPENGATEWAY_PRICES_URL,
	type OpenGatewayListedModel,
	type OpenGatewayPriceTable,
	openGatewayPrice,
	parseOpenGatewayListing,
	parseOpenGatewayPriceTable,
	servingTierBase,
	withGatewayPrice,
} from "../src/providers/opengateway-catalog.ts";
import type { Model, ModelCost } from "../src/types.ts";
import { asEnrichmentSource, type OpenGatewayEnrichmentSource } from "./opengateway-enrichment-schema.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";
const LAST_GOOD_CATALOG_PATH = join(dirname(fileURLToPath(import.meta.url)), "../src/providers/data/opengateway.json");

type ModelsDevProviderCatalogs = Record<string, { models?: Record<string, unknown> } | undefined>;

/** models.dev provider key used to enrich an OpenGateway owner prefix. */
const OPENGATEWAY_OWNER_TO_MODELS_DEV: Record<string, string> = {
	openai: "openai",
	anthropic: "anthropic",
	google: "google",
	"x-ai": "xai",
	moonshotai: "moonshotai",
	deepseek: "deepseek",
	"z-ai": "zai",
	minimax: "minimax",
	qwen: "alibaba",
};

interface OpenGatewayModelOverride {
	name: string;
	reasoning: boolean;
	cost: ModelCost;
	contextWindow: number;
	maxTokens: number;
}

/**
 * Metadata for gateway models models.dev cannot enrich. Gateway-published
 * limits and prices still win over these values; deprecated legacy ids use
 * historical public pricing.
 */
const OPENGATEWAY_MODEL_OVERRIDES: Record<string, OpenGatewayModelOverride> = {
	"moonshotai/kimi-k3-ultrafast": {
		name: "Kimi K3 Ultrafast",
		reasoning: true,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 131072,
	},
	"openai/gpt-4-0613": {
		name: "GPT-4 (0613)",
		reasoning: false,
		cost: { input: 30, output: 60, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 8192,
	},
	"openai/gpt-3.5-turbo-1106": {
		name: "GPT-3.5 Turbo (1106)",
		reasoning: false,
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16385,
		maxTokens: 4096,
	},
	"openai/gpt-3.5-turbo-0125": {
		name: "GPT-3.5 Turbo (0125)",
		reasoning: false,
		cost: { input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 16385,
		maxTokens: 4096,
	},
	"x-ai/grok-4-1-fast": {
		name: "Grok 4.1 Fast",
		reasoning: true,
		cost: { input: 0.2, output: 0.5, cacheRead: 0.05, cacheWrite: 0 },
		contextWindow: 2000000,
		maxTokens: 30000,
	},
};

function sourceCost(source: OpenGatewayEnrichmentSource | undefined, override: OpenGatewayModelOverride | undefined): ModelCost {
	const tiers = source?.cost?.tiers?.flatMap((tier) => {
		const context = tier.tier;
		if (context?.type !== "context" || context.size === undefined) return [];
		return [
			{
				inputTokensAbove: context.size,
				input: tier.input || 0,
				output: tier.output || 0,
				cacheRead: tier.cache_read || 0,
				cacheWrite: tier.cache_write || 0,
			},
		];
	});
	return {
		input: source?.cost?.input || override?.cost.input || 0,
		output: source?.cost?.output || override?.cost.output || 0,
		cacheRead: source?.cost?.cache_read || override?.cost.cacheRead || 0,
		cacheWrite: source?.cost?.cache_write || override?.cost.cacheWrite || 0,
		...(tiers && tiers.length > 0 ? { tiers } : {}),
	};
}

function lookupSource(id: string, modelsDev: ModelsDevProviderCatalogs): OpenGatewayEnrichmentSource | undefined {
	const [owner, upstreamId] = id.split("/", 2);
	const ownerKey = OPENGATEWAY_OWNER_TO_MODELS_DEV[owner];
	return (
		asEnrichmentSource(ownerKey ? modelsDev[ownerKey]?.models?.[upstreamId] : undefined) ??
		asEnrichmentSource(modelsDev.openrouter?.models?.[id])
	);
}

/**
 * A serving-tier variant without its own models.dev row borrows its base model's capabilities and
 * limits; its price is the gateway's, never the base model's.
 */
function servingTierSource(id: string, modelsDev: ModelsDevProviderCatalogs): OpenGatewayEnrichmentSource | undefined {
	const tier = servingTierBase(id);
	const base = tier ? lookupSource(tier.baseId, modelsDev) : undefined;
	if (!tier || !base) return undefined;
	return { ...base, name: base.name ? `${base.name} ${tier.label}` : undefined, cost: undefined };
}

export type OpenGatewayReasoningRecorder = (id: string, source: OpenGatewayEnrichmentSource) => void;

function buildModel(
	item: OpenGatewayListedModel,
	modelsDev: ModelsDevProviderCatalogs,
	prices: OpenGatewayPriceTable,
	recordReasoning: OpenGatewayReasoningRecorder,
): Model<"openai-completions"> | undefined {
	const override = OPENGATEWAY_MODEL_OVERRIDES[item.id];
	const source = lookupSource(item.id, modelsDev) ?? (override ? undefined : servingTierSource(item.id, modelsDev));
	if (!source && !override) {
		console.warn(`OpenGateway model ${item.id} has no models.dev metadata; skipping`);
		return undefined;
	}
	// Built-in catalogs are tool-capable only (same positive requirement as the
	// models.dev sections' tool_call !== true filter). Override-only entries
	// assert tool capability by design.
	if (source && source.tool_call !== true) return undefined;
	if (source) recordReasoning(item.id, source);

	return {
		id: item.id,
		name: source?.name || override?.name || item.id,
		api: "openai-completions",
		provider: "opengateway",
		baseUrl: OPENGATEWAY_BASE_URL,
		// The gateway rejects the OpenAI "developer" role with a 400 (verified 2026-08-12); always send "system".
		compat: { supportsDeveloperRole: false },
		reasoning: override?.reasoning ?? source?.reasoning === true,
		input: item.inputModalities.includes("image") ? ["text", "image"] : ["text"],
		cost: withGatewayPrice(sourceCost(source, override), openGatewayPrice(item, prices)),
		contextWindow: item.contextWindow || source?.limit?.context || override?.contextWindow || 4096,
		maxTokens: item.maxOutputTokens || source?.limit?.output || override?.maxTokens || 4096,
	};
}

async function fetchJson(url: string, label: string): Promise<unknown> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${label} returned ${response.status}`);
	return response.json();
}

/** The committed catalog: what a failed non-strict fetch keeps shipping instead of an empty provider. */
export function loadLastGoodOpenGatewayModels(path: string = LAST_GOOD_CATALOG_PATH): Model<any>[] {
	const grouped = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, Model<any>>>;
	return Object.values(grouped).flatMap((entries) => Object.values(entries));
}

export async function fetchOpenGatewayModels(
	recordReasoning: OpenGatewayReasoningRecorder,
	options: { strict: boolean; lastGoodCatalogPath?: string },
): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from OpenGateway API...");
		const [listing, prices, modelsDev] = await Promise.all([
			fetchJson(OPENGATEWAY_MODELS_URL, "OpenGateway API").then(parseOpenGatewayListing),
			fetchJson(OPENGATEWAY_PRICES_URL, "OpenGateway price table").then(parseOpenGatewayPriceTable),
			fetchJson(MODELS_DEV_URL, "models.dev API") as Promise<ModelsDevProviderCatalogs>,
		]);
		const models = listing
			.filter(isServableChatModel)
			.flatMap((item) => buildModel(item, modelsDev, prices, recordReasoning) ?? []);
		console.log(`Fetched ${models.length} chat-capable models from OpenGateway`);
		return models;
	} catch (error) {
		console.error("Failed to fetch OpenGateway models:", error);
		if (options.strict) throw error;
		const lastGood = loadLastGoodOpenGatewayModels(options.lastGoodCatalogPath);
		console.warn(`Keeping the last good OpenGateway catalog (${lastGood.length} models)`);
		return lastGood;
	}
}
