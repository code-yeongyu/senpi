// OpenGateway catalog fetch + enrichment for generate-models.ts.
//
// OpenGateway (https://apis.opengateway.ai) serves an OpenAI-compatible catalog at
// GET /v1/models with owner/model ids, modalities, supported endpoints, and a
// lifecycle status — but no pricing, context-window, or reasoning metadata. Those
// fields are enriched from models.dev: first the owning provider's own catalog
// (authoritative for limits and pricing), then the OpenRouter id space as fallback
// for models the owner catalog does not list.

import type { Model, ModelCost } from "../src/types.ts";
import type { ModelsDevReasoningOption } from "./models-dev-reasoning-options.ts";

const OPENGATEWAY_MODELS_URL = "https://apis.opengateway.ai/v1/models";
const OPENGATEWAY_BASE_URL = "https://apis.opengateway.ai/v1";
const MODELS_DEV_URL = "https://models.dev/api.json";

interface OpenGatewayCatalogModel {
	id: string;
	status?: string;
	modalities?: { input?: string[]; output?: string[] };
	endpoints?: string[];
}

/** Subset of the models.dev model entry used for OpenGateway enrichment. */
interface OpenGatewayEnrichmentSource {
	name?: string;
	tool_call?: boolean;
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	limit?: { context?: number; output?: number };
	cost?: {
		input?: number;
		output?: number;
		cache_read?: number;
		cache_write?: number;
		tiers?: {
			input?: number;
			output?: number;
			cache_read?: number;
			cache_write?: number;
			tier?: { type?: string; size?: number };
		}[];
	};
}

function toModelCost(
	source: OpenGatewayEnrichmentSource | undefined,
	override: OpenGatewayModelOverride | undefined,
): ModelCost {
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

type ModelsDevProviderCatalogs = Record<string, { models?: Record<string, OpenGatewayEnrichmentSource> } | undefined>;

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
 * Metadata for gateway models models.dev cannot enrich. Serving-tier variants
 * (kimi-k3-ultrafast, glm-5.2-ultrafast) inherit their base model's published
 * metadata; deprecated legacy ids use historical public pricing.
 */
const OPENGATEWAY_MODEL_OVERRIDES: Record<string, OpenGatewayModelOverride> = {
	"moonshotai/kimi-k3-ultrafast": {
		name: "Kimi K3 Ultrafast",
		reasoning: true,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 131072,
	},
	"z-ai/glm-5.2-ultrafast": {
		name: "GLM-5.2 Ultrafast",
		reasoning: true,
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		contextWindow: 1000000,
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

export type OpenGatewayReasoningRecorder = (id: string, source: OpenGatewayEnrichmentSource) => void;

export async function fetchOpenGatewayModels(
	recordReasoning: OpenGatewayReasoningRecorder,
	options: { strict: boolean },
): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from OpenGateway API...");
		const response = await fetch(OPENGATEWAY_MODELS_URL);
		if (!response.ok) throw new Error(`OpenGateway API returned ${response.status}`);
		const data = await response.json();

		const modelsDevResponse = await fetch(MODELS_DEV_URL);
		if (!modelsDevResponse.ok) throw new Error(`models.dev API returned ${modelsDevResponse.status}`);
		const modelsDevData = (await modelsDevResponse.json()) as ModelsDevProviderCatalogs;
		const openRouterModels = modelsDevData.openrouter?.models ?? {};

		const models: Model<any>[] = [];
		const items = Array.isArray(data.data) ? (data.data as OpenGatewayCatalogModel[]) : [];
		for (const item of items) {
			// The LLM catalog covers chat-completions models only; image-generation and
			// embedding models are out of scope, and retired models cannot be called.
			if (!item.endpoints?.includes("chat_completions")) continue;
			if (item.status === "retired") continue;

			const [owner, upstreamId] = item.id.split("/", 2);
			const fallbackKey = OPENGATEWAY_OWNER_TO_MODELS_DEV[owner];
			const source =
				(fallbackKey ? modelsDevData[fallbackKey]?.models?.[upstreamId] : undefined) ??
				openRouterModels[item.id];
			const override = OPENGATEWAY_MODEL_OVERRIDES[item.id];
			if (!source && !override) {
				console.warn(`OpenGateway model ${item.id} has no models.dev metadata; skipping`);
				continue;
			}
			// Built-in catalogs are tool-capable only (same positive requirement as the
			// models.dev sections' tool_call !== true filter). Override-only entries
			// assert tool capability by design.
			if (source && source.tool_call !== true) continue;
			if (source) recordReasoning(item.id, source);

			const input: ("text" | "image")[] = ["text"];
			if (item.modalities?.input?.includes("image")) input.push("image");

			models.push({
				id: item.id,
				name: source?.name || override?.name || item.id,
				api: "openai-completions",
				provider: "opengateway",
				baseUrl: OPENGATEWAY_BASE_URL,
				compat: {
					// The gateway rejects the OpenAI "developer" role with a 400
					// (verified 2026-08-12); always send "system" instead.
					supportsDeveloperRole: false,
				},
				reasoning: override?.reasoning ?? (source?.reasoning === true),
				input,
				cost: toModelCost(source, override),
				contextWindow: source?.limit?.context || override?.contextWindow || 4096,
				maxTokens: source?.limit?.output || override?.maxTokens || 4096,
			});
		}

		console.log(`Fetched ${models.length} chat-capable models from OpenGateway`);
		return models;
	} catch (error) {
		console.error("Failed to fetch OpenGateway models:", error);
		if (options.strict) throw error;
		return [];
	}
}
