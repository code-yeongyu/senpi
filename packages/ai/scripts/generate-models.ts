#!/usr/bin/env node

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { getBaiModels } from "./generate-models-bai.ts";
import { fetchOpenGatewayModels } from "./generate-models-opengateway.ts";
import { applyOpenAiInputCap } from "../src/utils/openai-input-cap.ts";
import { MODEL_SHARD_SUFFIX, importedModelShards, isPrunableModelShard } from "./model-shards.ts";
import { getEffortThinkingLevelMap, type ModelsDevReasoningOption } from "./models-dev-reasoning-options.ts";
import { buildOpenRouterCatalog, type OpenRouterCatalog, type OpenRouterModelListItem } from "./openrouter-catalog.ts";
import {
	CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
	CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_BASE_URL,
	CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
} from "../src/api/cloudflare.ts";
import type {
	AnthropicMessagesCompat,
	AnyModel,
	Api,
	BedrockCompat,
	ClassifierApi,
	ClassifierModel,
	ImageApi,
	ImageModel,
	KnownProvider,
	Model,
	ModelCost,
	ModelPromptCache,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "../src/types.ts";
import {
	assertExactModelIds,
	createModelDataManifest,
	type ModelDataStructure,
	MODEL_DATA_MANIFEST_FILE,
	readModelDataProviderIds,
	readModelDataStructure,
	validateGeneratedModelData,
	validateModelDataDirectory,
} from "./model-data.ts";
import {
	DEFAULT_RADIUS_GATEWAY,
	getRadiusModelsFromConfig,
	loadRadiusGatewayConfig,
} from "../src/providers/radius-config.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = join(__dirname, "..");

function readGeneratorOptions(args: string[]): {
	strict: boolean;
	dataOnly: boolean;
	jsonOnly: boolean;
	jsonOutputDir: string | undefined;
	pretty: boolean;
	providerIds: string[] | undefined;
	generatedAt: string | undefined;
} {
	let strict = false;
	let dataOnly = false;
	let jsonOnly = false;
	let jsonOutputDir: string | undefined;
	let pretty = false;
	let providerIds: string[] | undefined;
	let generatedAt: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--strict") {
			strict = true;
			continue;
		}
		if (arg === "--data-only") {
			dataOnly = true;
			continue;
		}
		if (arg === "--json-only") {
			jsonOnly = true;
			continue;
		}
		if (arg === "--pretty") {
			pretty = true;
			continue;
		}
		if (arg === "--json-output") {
			const value = args[++index];
			if (!value) throw new Error("--json-output requires a directory");
			jsonOutputDir = resolve(value);
			continue;
		}
		if (arg === "--providers") {
			const value = args[++index];
			if (!value) throw new Error("--providers requires a comma-separated provider list");
			const values = value.split(",").map((providerId) => providerId.trim());
			if (values.some((providerId) => providerId.length === 0)) {
				throw new Error("--providers cannot contain empty provider IDs");
			}
			providerIds = Array.from(new Set(values)).sort();
			if (providerIds.length !== values.length) throw new Error("--providers cannot contain duplicate provider IDs");
			continue;
		}
		if (arg === "--generated-at") {
			const value = args[++index];
			if (!value || Number.isNaN(Date.parse(value))) throw new Error("--generated-at requires an ISO timestamp");
			generatedAt = new Date(value).toISOString();
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (jsonOnly && !jsonOutputDir) throw new Error("--json-only requires --json-output");
	if (dataOnly && (jsonOnly || jsonOutputDir)) throw new Error("--data-only cannot be combined with JSON catalog output");
	if (providerIds && (dataOnly || jsonOnly || jsonOutputDir)) {
		throw new Error("--providers cannot be combined with --data-only or JSON catalog output");
	}
	return { strict, dataOnly, jsonOnly, jsonOutputDir, pretty, providerIds, generatedAt };
}

const generatorOptions = readGeneratorOptions(process.argv.slice(2));

interface ModelsDevModel {
	id: string;
	name: string;
	tool_call?: boolean;
	structured_output?: boolean;
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	status?: string;
	limit?: {
		context?: number;
		output?: number;
	};
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
			tier?: {
				type?: string;
				size?: number;
			};
		}[];
	};
	modalities?: {
		input?: string[];
		output?: string[];
	};
	provider?: {
		npm?: string;
	};
}

interface ModelsDevProvider {
	models?: Record<string, ModelsDevModel>;
}

interface ModelsDevMetadata {
	id: string;
	type?: string;
	name: string;
	limit?: { context?: number };
	modalities?: { input?: string[] };
}

type ModelsDevCatalog = Record<string, ModelsDevProvider>;

interface NvidiaNimModelListItem {
	id: string;
}

interface AiGatewayModel {
	id: string;
	name?: string;
	type?: string;
	context_window?: number;
	max_tokens?: number;
	tags?: string[];
	pricing?: {
		input?: string | number;
		output?: string | number;
		input_cache_read?: string | number;
		input_cache_write?: string | number;
	};
}

const COPILOT_STATIC_HEADERS = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
} as const;

const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
// Venice's ChatCompletionRequest schema is `additionalProperties: false`, so only
// documented fields may be sent. Everything senpi sends by default for an
// unrecognized OpenAI-compatible host is on Venice's accepted list (`store`,
// `developer` role, `reasoning_effort`, `stream_options.include_usage`,
// `max_completion_tokens`, `prompt_cache_key`, `prompt_cache_retention`, and
// `strict` tools), so the auto-detected compat defaults are left alone.
// The one behavior that must be overridden: Venice prepends its own default
// system prompt ahead of the caller's unless told not to, which would sit in
// front of the agent's system prompt.
const VENICE_COMPAT: OpenAICompletionsCompat = {
	veniceParameters: { include_venice_system_prompt: false },
};

const TOGETHER_BASE_URL = "https://api.together.ai/v1";
const TOGETHER_BASE_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};
const TOGETHER_TOGGLE_REASONING_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_BASE_COMPAT,
	thinkingFormat: "together",
};
const TOGETHER_REASONING_EFFORT_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_BASE_COMPAT,
	supportsReasoningEffort: true,
	thinkingFormat: "openai",
};
const TOGETHER_TOGGLE_REASONING_EFFORT_COMPAT: OpenAICompletionsCompat = {
	...TOGETHER_TOGGLE_REASONING_COMPAT,
	supportsReasoningEffort: true,
};
const TOGETHER_REASONING_ONLY_MODELS = new Set([
	"deepseek-ai/DeepSeek-R1",
	"MiniMaxAI/MiniMax-M2.7",
]);
const TOGETHER_REASONING_EFFORT_MODELS = new Set(["openai/gpt-oss-20b", "openai/gpt-oss-120b"]);
const TOGETHER_TOGGLE_REASONING_EFFORT_MODELS = new Set(["deepseek-ai/DeepSeek-V4-Pro"]);
const TOGETHER_FIXED_REASONING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
} as const;
const TOGETHER_REASONING_EFFORT_LEVEL_MAP = {
	off: null,
	minimal: null,
} as const;
const TOGETHER_DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
} as const;
const TOGETHER_TOGGLE_REASONING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
} as const;
const TOGGLE_ONLY_THINKING_FORMATS = new Set([
	"deepseek",
	"qwen",
	"qwen-chat-template",
	"string-thinking",
	"together",
	"zai",
]);
const TOGGLE_ONLY_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	xhigh: null,
	max: null,
} as const;

const AI_GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1";
const AI_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh";
// TypeSafe-compatible System One endpoint for evaluation models.
// https://vercel.com/docs/ai-gateway/sdks-and-apis/typesafe
const AI_GATEWAY_TYPESAFE_BASE_URL = "https://ai-gateway.vercel.sh/typesafe/v1";
const VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_HEADERS = {
	"NVCF-POLL-SECONDS": "3600",
} as const;
const NVIDIA_OPENAI_COMPAT: OpenAICompletionsCompat = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
	supportsLongCacheRetention: false,
};
const NVIDIA_NIM_UNSUPPORTED_MODELS = new Set([
	"abacusai/dracarys-llama-3.1-70b-instruct",
	"bytedance/seed-oss-36b-instruct",
	"deepseek-ai/deepseek-v4-flash",
	"deepseek-ai/deepseek-v4-pro",
	"google/gemma-2-2b-it",
	"google/gemma-3n-e2b-it",
	"google/gemma-3n-e4b-it",
	"google/gemma-4-31b-it",
	"meta/llama-3.2-1b-instruct",
	"meta/llama-4-maverick-17b-128e-instruct",
	"microsoft/phi-4-mini-instruct",
	"minimaxai/minimax-m2.7",
	"mistralai/mistral-nemotron",
	"nvidia/nemotron-mini-4b-instruct",
	"qwen/qwen3-next-80b-a3b-instruct",
	"qwen/qwen3.5-397b-a17b",
	"sarvamai/sarvam-m",
	"upstage/solar-10.7b-instruct",
]);
const ZAI_TOOL_STREAM_UNSUPPORTED_MODELS = new Set(["glm-4.5", "glm-4.5-air", "glm-4.5-flash", "glm-4.5v"]);
const ZAI_GLM52_THINKING_LEVEL_MAP = {
	off: "none",
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;
const OPENCODE_GO_GLM52_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;
const EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS = new Set([
	"github-copilot:claude-haiku-4.5",
	"github-copilot:claude-sonnet-4",
	"github-copilot:claude-sonnet-4.5",
]);
const ANTHROPIC_ALLOWED_FALLBACK_MODELS = {
	"claude-fable-5-1": ["claude-opus-4-8", "claude-opus-5"],
	"claude-fable-5": ["claude-opus-4-8", "claude-opus-5"],
	"claude-opus-5-5": ["claude-opus-4-8", "claude-opus-5"],
	"claude-opus-5": ["claude-opus-4-8"],
	"claude-sonnet-5-5": ["claude-sonnet-5"],
} satisfies Record<string, string[]>;

const DEEPSEEK_V4_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	max: "max",
} as const;
const DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP = {
	...DEEPSEEK_V4_THINKING_LEVEL_MAP,
	low: "low",
} as const;
// Verified against Fireworks Messages raw_output on 2026-09-10 (#9323).
// Fall back to verified support when models.dev omits effort metadata; this is
// not an allowlist. Any Fireworks Messages model advertising effort uses adaptive thinking.
const FIREWORKS_ADAPTIVE_THINKING_FALLBACK_MODELS = new Set([
	"accounts/fireworks/models/deepseek-v4-flash-0731",
	"accounts/fireworks/models/deepseek-v4-flash-vision-exp",
	"accounts/fireworks/models/deepseek-v4-pro-0813",
	"accounts/fireworks/models/qwen3p8-max",
	"accounts/fireworks/models/qwen3p8-2p4t-a95b",
]);
const QWEN_TOKEN_PLAN_FALLBACK_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;
const QWEN_TOKEN_PLAN_REASONING_EFFORT_FALLBACK_MODEL_IDS = new Set(["glm-5", "glm-5.1"]);
// Retired preview id — models.dev may still list it after GA ships.
const QWEN_TOKEN_PLAN_EXCLUDED_MODEL_IDS = new Set(["qwen3.8-max-preview"]);
const QWEN_TOKEN_PLAN_PROVIDER_IDS = new Set<string>([
	"qwen-token-plan",
	"qwen-token-plan-cn",
	"qwen-token-plan-individual",
]);
// QwenCloud Token Plan Individual text-model allowlist, verified 2026-09-03.
// Retired models remain excluded above even if the public catalog lags.
// https://docs.qwencloud.com/token-plan/personal/token-plan-personal-overview
const QWEN_TOKEN_PLAN_INDIVIDUAL_MODEL_IDS = new Set<string>([
	"deepseek-v4-flash-0731",
	"deepseek-v4-pro",
	"deepseek-v4-pro-0813",
	"glm-5.2",
	"qwen3.6-flash",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-flash",
	"qwen3.8-max",
]);

const KIMI_K3_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: null,
	xhigh: null,
	max: "max",
} as const;
const KIMI_K3_MAX_TOKENS = 131072;
// Official Kimi K3 API prices per 1M tokens (platform.kimi.ai/docs/pricing/chat): cache writes bill at the
// default 5-minute TTL rate, $3 ($6 for the 1-hour TTL); a cache hit bills only the cached-input price.
const KIMI_K3_COST = {
	input: 3,
	output: 15,
	cacheRead: 0.3,
	cacheWrite: 3,
} as const;
const KIMI_CODING_STABLE_MODELS = {
	"kimi-for-coding": {
		id: "kimi-for-coding",
		name: "Kimi For Coding",
		tool_call: true,
		reasoning: true,
		limit: { context: 262144, output: 32768 },
		modalities: { input: ["text", "image"] },
	},
	"kimi-k2-thinking": {
		id: "kimi-k2-thinking",
		name: "Kimi K2 Thinking",
		tool_call: true,
		reasoning: true,
		limit: { context: 262144, output: 32768 },
		modalities: { input: ["text"] },
	},
} satisfies Record<string, ModelsDevModel>;
// Kimi Coding is subscription-backed, so models.dev reports zero cost. Use the
// equivalent Moonshot API rates to estimate the value of subscription usage.
const KIMI_CODING_IMPLIED_COSTS: Record<string, Model<Api>["cost"]> = {
	k3: KIMI_K3_COST,
	"kimi-for-coding": { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
	"kimi-for-coding-highspeed": { input: 1.9, output: 8, cacheRead: 0.38, cacheWrite: 0 },
	"kimi-k2-thinking": { input: 0.6, output: 2.5, cacheRead: 0.15, cacheWrite: 0 },
};
const OPENROUTER_KIMI_K3_MODEL_IDS = new Set(["moonshotai/kimi-k3", "~moonshotai/kimi-latest"]);

const ANT_LING_RING_THINKING_LEVEL_MAP = {
	off: null,
	minimal: null,
	low: null,
	medium: null,
	high: "high",
	xhigh: "xhigh",
} as const;

const BEDROCK_INFERENCE_PROFILE_ONLY_MODEL_IDS = new Set(["anthropic.claude-opus-5", "anthropic.claude-opus-5-5"]);
const MODELS_DEV_OPENAI_UNSUPPORTED_MODEL_IDS = new Set(["gpt-5.6"]);
const OPENAI_TOOL_SEARCH_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6.1-sol",
	"gpt-6-sol",
	"gpt-6-luna",
]);
const OPENAI_ADDITIONAL_TOOLS_MODEL_IDS = OPENAI_TOOL_SEARCH_MODEL_IDS;
const OPENAI_MID_CONVO_SYSTEM_MESSAGE_MODEL_IDS = OPENAI_TOOL_SEARCH_MODEL_IDS;
const CHATGPT_SUBSCRIPTION_ADDITIONAL_TOOLS_MODEL_IDS = new Set([
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6.1-sol",
	"gpt-6-sol",
	"gpt-6-luna",
]);
const OPENAI_LONG_CONTEXT_INPUT_THRESHOLD = 272000;
// OpenAI budgets input and output separately: the Responses API rejects a request with
// `context_too_large` once the prompt alone exceeds (documented context window - max output),
// whatever `max_output_tokens` asks for. senpi's `contextWindow` is the prompt budget, so the
// catalog stores the input cap: 272,000 for the 400,000 tier and 922,000 for the 1,050,000 tier.
// The split follows the model, not the gateway: `applyOpenAiInputCap` runs over every provider's
// GPT-5.x / GPT-6 rows (Azure, Bedrock, Copilot, OpenRouter, Vercel, OpenGateway, OpenCode...)
// because those gateways forward the same upstream limit. Issue #1422.
const OPENAI_MAX_CONTEXT_INPUT_CAP = 922000;
// Flagship default context windows. OpenAI documents a 1,050,000-token window for every one of
// these models; the project deliberately ships cost-tier prompt budgets (users widen through model
// overrides): GPT-5.6 Sol keeps 650,000; GPT-6 Astra keeps 600,000; GPT-6 Sol and GPT-6.1 Sol
// ship 400,000 (same price tier, developers.openai.com/api/docs/models/gpt-6.1-sol documents the
// same 1,050,000 window and 922,000 input cap); GPT-6 Luna ships the full 922,000 input cap.
const GPT_6_ASTRA_DEFAULT_CONTEXT_WINDOW = 600000;
const GPT_6_SOL_DEFAULT_CONTEXT_WINDOW = 400000;
const GPT_6_LUNA_DEFAULT_CONTEXT_WINDOW = OPENAI_MAX_CONTEXT_INPUT_CAP;
const OPENAI_FLAGSHIP_DEFAULT_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
	["gpt-5.6-sol", 650000],
	["gpt-6-astra", GPT_6_ASTRA_DEFAULT_CONTEXT_WINDOW],
	["gpt-6.1-sol", GPT_6_SOL_DEFAULT_CONTEXT_WINDOW],
	["gpt-6-sol", GPT_6_SOL_DEFAULT_CONTEXT_WINDOW],
	["gpt-6-luna", GPT_6_LUNA_DEFAULT_CONTEXT_WINDOW],
]);
const GPT_56_SOL_DEFAULT_CONTEXT_WINDOW = 650000;
// Every GPT-6 tier id, in the order a prefixed or suffixed id is matched (gpt-6-astra-fast,
// openai/gpt-6-sol, openai-gpt-6-luna, openai/gpt-6.1-sol). Venice drops the point-release dot
// (openai-gpt-61-sol, as it does for openai-gpt-56-sol), so the dotless marker is listed too.
// Bare "gpt-6" and "gpt-6.1" stay out so an unknown sibling is not stamped with a tier it
// does not have.
const GPT_6_FAMILY_DEFAULT_CONTEXT_WINDOWS: ReadonlyArray<readonly [marker: string, contextWindow: number]> = [
	["gpt-6-astra", GPT_6_ASTRA_DEFAULT_CONTEXT_WINDOW],
	["gpt-6.1-sol", GPT_6_SOL_DEFAULT_CONTEXT_WINDOW],
	["gpt-61-sol", GPT_6_SOL_DEFAULT_CONTEXT_WINDOW],
	["gpt-6-sol", GPT_6_SOL_DEFAULT_CONTEXT_WINDOW],
	["gpt-6-luna", GPT_6_LUNA_DEFAULT_CONTEXT_WINDOW],
];

/** GPT-6.1 Sol under either id spelling: `gpt-6.1-sol` or Venice's dotless `gpt-61-sol`. */
function isGpt61SolId(modelId: string): boolean {
	return modelId.includes("gpt-6.1-sol") || modelId.includes("gpt-61-sol");
}

function gpt6FamilyDefaultContextWindow(modelId: string): number | undefined {
	return GPT_6_FAMILY_DEFAULT_CONTEXT_WINDOWS.find(([marker]) => modelId.includes(marker))?.[1];
}

function isGpt6FamilyId(modelId: string): boolean {
	return gpt6FamilyDefaultContextWindow(modelId) !== undefined;
}

const OPENAI_SHORT_CONTEXT_CAPPED_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6.1-sol",
	"gpt-6-sol",
	"gpt-6-luna",
]);
const OPENAI_LONG_CONTEXT_PRICING_MODEL_IDS = new Set([
	"gpt-5.4",
	"gpt-5.4-pro",
	"gpt-5.5",
	"gpt-5.5-pro",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-astra",
	"gpt-6.1-sol",
	"gpt-6-sol",
	"gpt-6-luna",
]);

// Keep the generated default no less restrictive than coding-agent's historical
// image preprocessing. Provider limits can narrow this profile, but unknown
// providers retain the cache-safe 2000px / 4.5 MiB behavior.
const DEFAULT_IMAGE_RESIZE = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: 4.5 * 1024 * 1024,
	jpegQuality: 80,
} as const;

function withOpenAiLongContextPricing(cost: Model<Api>["cost"]): Model<Api>["cost"] {
	return {
		...cost,
		tiers: [
			{
				inputTokensAbove: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
				input: roundCost(cost.input * 2),
				output: roundCost(cost.output * 1.5),
				cacheRead: roundCost(cost.cacheRead * 2),
				cacheWrite: roundCost(cost.cacheWrite * 2),
			},
		],
	};
}

// GPT-6 Sol / Luna list prices (developers.openai.com/api/docs/models/gpt-6-sol, gpt-6-luna).
// GPT-6.1 Sol (2026-09-29) keeps Sol's input/output rates and halves cached input to 0.10
// (developers.openai.com/api/docs/models/gpt-6.1-sol).
const OPENAI_GPT_6_STANDARD_COSTS: Record<string, ModelCost> = {
	"gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
	"gpt-6-sol": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
	"gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
// Keep current OpenAI prices authoritative until models.dev and passthrough
// catalogs catch up.
// https://developers.openai.com/api/docs/pricing
const OPENAI_STANDARD_COSTS: Record<string, ModelCost> = {
	"gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
	"gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
	"gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
	"gpt-6-astra": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	...OPENAI_GPT_6_STANDARD_COSTS,
};

const OPENAI_RESPONSES_NONE_REASONING_MODELS = new Set([
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
	"gpt-5.5",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-6-sol",
	"gpt-6-luna",
]);
// OpenAI models with Priority processing support, per the OpenAI pricing page's
// Priority table. `-fast` catalog variants are generated for exactly this set.
const OPENAI_PRIORITY_TIER_MODEL_IDS = new Set([
	"gpt-6-astra",
	"gpt-6.1-sol",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.2",
	"gpt-5.1",
	"gpt-5",
	"gpt-5-mini",
	"gpt-4.1",
	"gpt-4.1-mini",
	"gpt-4.1-nano",
	"gpt-4o",
	"gpt-4o-2024-05-13",
	"gpt-4o-mini",
	"o3",
	"o4-mini",
]);

// Codex backend models eligible for Priority-tier -fast variants. Mirrors the
// OpenAI priority list but restricted to GPT-5.6 reasoning models that ship on
// the Codex Responses API; older Codex-only SKUs (gpt-5.3-codex-spark) are
// Priority-ineligible.
const CHATGPT_SUBSCRIPTION_PRIORITY_TIER_MODEL_IDS = new Set([
	"gpt-6-astra",
	"gpt-6.1-sol",
	"gpt-6-sol",
	"gpt-6-luna",
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);
const XAI_BUILTIN_EXCLUDED_MODEL_IDS = new Set([
	"grok-3",
	"grok-3-fast",
	"grok-build-0.1",
	"grok-code-fast-1",
]);
// Documented per-model xAI reasoning specifications. Grok 4.6 exposes low/medium/high/xhigh;
// the fixed-reasoning Grok 4.20 variant exposes only `high`. Models without an entry fall back
// to `applyThinkingLevelMetadata()`'s "no verified effort options" defaults.
const XAI_THINKING_LEVEL_MAPS: Record<string, NonNullable<Model<"openai-responses">["thinkingLevelMap"]>> = {
	"grok-4.6": {
		off: null,
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: null,
	},
	"grok-4.20-0309-reasoning": {
		off: null,
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	},
};
const XAI_RESPONSES_COMPAT: OpenAIResponsesCompat = {
	supportsLongCacheRetention: false,
};

const OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS = new Set([
	"opencode:deepseek-v4-flash",
	"opencode:deepseek-v4-pro",
	"opencode:kimi-k2.5",
	"opencode:kimi-k2.6",
	"opencode:kimi-k2.7-code",
	"opencode:minimax-m2.7",
	"opencode-go:kimi-k2.6",
]);

// GitHub's "Models with extended capabilities" table lists these Copilot models as supporting
// the extended 1 million token context window.
const GITHUB_COPILOT_EXTENDED_CONTEXT_MODELS = new Set([
	"claude-fable-5",
	"claude-opus-4.6",
	"claude-opus-4.7",
	"claude-opus-4.8",
	"claude-opus-5",
	"claude-opus-5.5",
	"claude-sonnet-4.6",
	"claude-sonnet-5",
	"gpt-5.3-codex",
	"gpt-5.4",
	"gpt-5.5",
	"gpt-6-astra",
	"gpt-6-luna",
	"gpt-6-sol",
]);

// Checked manually against the authenticated GitHub Copilot /models endpoint on 2026-06-15.
// Keep this to narrow corrections over models.dev metadata instead of snapshotting Copilot's catalog.
const GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES = {
	"claude-opus-4.7": { minimal: "low" },
	"claude-opus-4.8": { minimal: "low" },
	"claude-opus-5": { minimal: "low" },
	"claude-sonnet-4.6": { minimal: "low", max: "max" },
} satisfies Record<string, NonNullable<Model<Api>["thinkingLevelMap"]>>;

function mergeThinkingLevelMap(model: Model<any>, map: NonNullable<Model<any>["thinkingLevelMap"]>): void {
	model.thinkingLevelMap = { ...model.thinkingLevelMap, ...map };
}

const modelsDevReasoningOptions = new Map<string, ModelsDevReasoningOption[]>();

function getModelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}:${model.id}`;
}

function recordModelsDevReasoningOptions(provider: string, id: string, sourceModel: ModelsDevModel): void {
	if (sourceModel.reasoning_options !== undefined) {
		modelsDevReasoningOptions.set(`${provider}:${id}`, sourceModel.reasoning_options);
	}
}

function supportsDirectReasoningEffort(model: Model<Api>): boolean {
	if (model.api === "anthropic-messages") return model.compat?.forceAdaptiveThinking === true;
	if (
		model.api === "openai-responses" ||
		model.api === "azure-openai-responses" ||
		model.api === "openai-codex-responses"
	) {
		return true;
	}
	if (model.api !== "openai-completions") return false;

	const compat = {
		...detectOpenAICompletionsCompat(model as Model<"openai-completions">),
		...(model.compat as OpenAICompletionsCompat | undefined),
	};
	return compat.thinkingFormat === "openai" && compat.supportsReasoningEffort;
}

function applyModelsDevReasoningOptionMetadata(model: Model<Api>): void {
	const reasoningOptions = modelsDevReasoningOptions.get(getModelKey(model));
	if (!reasoningOptions || !supportsDirectReasoningEffort(model)) return;
	const thinkingLevelMap = getEffortThinkingLevelMap(reasoningOptions);
	if (thinkingLevelMap) mergeThinkingLevelMap(model, thinkingLevelMap);
}

function applyToggleOnlyThinkingLevelMap(model: Model<Api>): void {
	if (model.api !== "openai-completions" || !model.reasoning || model.thinkingLevelMap !== undefined) return;

	const compat = model.compat as OpenAICompletionsCompat | undefined;
	const reasoningOptions = modelsDevReasoningOptions.get(getModelKey(model));
	if (
		compat?.supportsReasoningEffort !== false ||
		compat.thinkingFormat === undefined ||
		!TOGGLE_ONLY_THINKING_FORMATS.has(compat.thinkingFormat) ||
		reasoningOptions?.some((option) => option.type === "effort")
	) {
		return;
	}

	model.thinkingLevelMap = { ...TOGGLE_ONLY_THINKING_LEVEL_MAP };
}

function getTogetherCompat(modelId: string, reasoning: boolean): OpenAICompletionsCompat {
	if (!reasoning) return TOGETHER_BASE_COMPAT;
	if (TOGETHER_REASONING_EFFORT_MODELS.has(modelId)) return TOGETHER_REASONING_EFFORT_COMPAT;
	if (TOGETHER_TOGGLE_REASONING_EFFORT_MODELS.has(modelId)) return TOGETHER_TOGGLE_REASONING_EFFORT_COMPAT;
	if (TOGETHER_REASONING_ONLY_MODELS.has(modelId)) return TOGETHER_BASE_COMPAT;
	return TOGETHER_TOGGLE_REASONING_COMPAT;
}

function getTogetherThinkingLevelMap(
	modelId: string,
	reasoning: boolean,
): NonNullable<Model<any>["thinkingLevelMap"]> | undefined {
	if (!reasoning) return undefined;
	if (TOGETHER_REASONING_EFFORT_MODELS.has(modelId)) return { ...TOGETHER_REASONING_EFFORT_LEVEL_MAP };
	if (TOGETHER_TOGGLE_REASONING_EFFORT_MODELS.has(modelId)) return { ...TOGETHER_DEEPSEEK_V4_THINKING_LEVEL_MAP };
	if (TOGETHER_REASONING_ONLY_MODELS.has(modelId)) return { ...TOGETHER_FIXED_REASONING_LEVEL_MAP };
	return { ...TOGETHER_TOGGLE_REASONING_LEVEL_MAP };
}

function supportsOpenAiXhigh(modelId: string): boolean {
	return (
		modelId.includes("gpt-5.2") ||
		modelId.includes("gpt-5.3") ||
		modelId.includes("gpt-5.4") ||
		modelId.includes("gpt-5.5") ||
		modelId.includes("gpt-5.6") ||
		isGpt6FamilyId(modelId)
	);
}

/**
 * `getBaiModels()` derives `reasoning` from B.AI's own published metadata, but
 * the shared thinking-level passes merge levels by model id afterwards. Without
 * this re-derivation a B.AI model that gained a selectable level keeps
 * `reasoning: false`, and the Responses and Messages adapters then skip the
 * reasoning payload entirely, making that level unreachable.
 */
function applyBaiReasoningConsistency(model: Model<Api>): void {
	if (model.provider !== "bai" || model.thinkingLevelMap === undefined) return;
	if (Object.values(model.thinkingLevelMap).some((level) => level !== null && level !== undefined)) {
		model.reasoning = true;
	}
}

function supportsOpenAiMax(model: Model<Api>): boolean {
	return (
		(model.id.includes("gpt-5.6") || isGpt6FamilyId(model.id)) &&
		(model.api === "openai-responses" ||
			model.api === "azure-openai-responses" ||
			model.api === "openai-codex-responses" ||
			model.api === "openai-completions")
	);
}

const VERIFIED_ANTHROPIC_MID_CONVO_EFFORT_PROVIDERS = new Set(["anthropic", "openrouter"]);
// OpenRouter rejects `configuration_update` system messages on Opus 5 ("Mid-conversation
// reasoning effort (configuration_update) is not supported on anthropic/claude-opus-5-20260723")
// while accepting them on Fable 5.1, so gate that model there.
const MID_CONVO_EFFORT_UNSUPPORTED_ANTHROPIC_MODELS = new Set(["openrouter:anthropic/claude-opus-5"]);

function supportsAnthropicMidConvoEffort(modelId: string): boolean {
	const id = modelId.toLowerCase().replace(/^~?anthropic\//, "");
	return (
		/^claude-opus-5(?:[.-]5)?(?:-\d{8})?$/.test(id) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(id) ||
		/^claude-(?:fable|mythos)-5(?:[.-]1)(?:-\d{8})?$/.test(id)
	);
}

// Opus 5.5 and Sonnet 5.5 reject `thinking: {type: "disabled"}` and `{type: "enabled"}` alike (400:
// `"thinking.type.disabled" is not supported for this model`); only adaptive thinking is accepted.
// Haiku 5.5 rejects `enabled` too, but its effort docs accept `disabled` at effort `high` or below (400 only
// at `xhigh` / `max`, and a differing per-message effort while disabled is a 400). Exposing that real
// thinking-off needs marker handling (senpi#2927), so until then it is held to the adaptive-only contract,
// whose thinking-off shape (unset + effort `low`) is valid either way.
function isAnthropicAdaptiveOnlyModel(modelId: string): boolean {
	return (
		modelId.includes("fable-5") ||
		modelId.includes("opus-5-5") ||
		modelId.includes("opus-5.5") ||
		modelId.includes("sonnet-5-5") ||
		modelId.includes("sonnet-5.5") ||
		modelId.includes("haiku-5-5") ||
		modelId.includes("haiku-5.5")
	);
}

function supportsAnthropicMidConvoSystemMessages(modelId: string): boolean {
	return (
		/^claude-opus-(?:4[.-]8|5(?:[.-]5)?)(?:-\d{8})?$/.test(modelId) ||
		/^claude-(?:sonnet|haiku)-5[.-]5(?:-\d{8})?$/.test(modelId) ||
		/^claude-(?:fable|mythos)-5(?:[.-]1)?(?:-\d{8})?$/.test(modelId)
	);
}

function isAnthropicAdaptiveThinkingModel(modelId: string): boolean {
	return (
		modelId.includes("opus-4-6") ||
		modelId.includes("opus-4.6") ||
		modelId.includes("opus-4-7") ||
		modelId.includes("opus-4.7") ||
		modelId.includes("opus-4-8") ||
		modelId.includes("opus-4.8") ||
		modelId.includes("opus-5") ||
		modelId.includes("opus.5") ||
		modelId.includes("sonnet-4-6") ||
		modelId.includes("sonnet-4.6") ||
		modelId.includes("sonnet-5") ||
		modelId.includes("sonnet.5") ||
		modelId.includes("opus-5") ||
		modelId.includes("opus.5") ||
		modelId.includes("fable-5") ||
		modelId.includes("haiku-5-5") ||
		modelId.includes("haiku-5.5")
	);
}

function isAnthropicTemperatureUnsupportedModel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return (
		id.includes("opus-4-7") ||
		id.includes("opus-4.7") ||
		id.includes("opus-4-8") ||
		id.includes("opus-4.8") ||
		id.includes("opus-5") ||
		id.includes("opus.5") ||
		id.includes("sonnet-5-5") ||
		id.includes("sonnet-5.5") ||
		id.includes("haiku-5-5") ||
		id.includes("haiku-5.5")
	);
}

const OPENAI_COMPLETIONS_DEFAULT_COMPAT = {
	supportsStore: true,
	supportsDeveloperRole: true,
	supportsReasoningEffort: true,
	supportsUsageInStreaming: true,
	supportsFinishReason: true,
	maxTokensField: "max_completion_tokens",
	requiresToolResultName: false,
	requiresAssistantAfterToolResult: false,
	requiresThinkingAsText: false,
	requiresReasoningContentOnAssistantMessages: false,
	thinkingFormat: "openai",
	openRouterRouting: {},
	vercelGatewayRouting: {},
	chatTemplateKwargs: {},
	chatTemplateArgs: {},
	zaiToolStream: false,
	supportsStrictMode: false,
	supportsOpenAIGrammarTools: false,
	supportsMidConvoSystemMessages: false,
	supportsMidConvoToolAdditions: false,
	sendSessionAffinityHeaders: false,
	supportsPromptCacheKey: false,
	supportsLongCacheRetention: true,
} satisfies Required<
	Omit<
		OpenAICompletionsCompat,
		"cacheControlFormat" | "supportsThinkingTokenBudget" | "thinkingTokenBudgetField"
	>
> & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

type OpenAICompletionsResolvedCompat = typeof OPENAI_COMPLETIONS_DEFAULT_COMPAT & {
	cacheControlFormat?: OpenAICompletionsCompat["cacheControlFormat"];
};

function mergeAnthropicMessagesCompat(model: Model<Api>, compat: AnthropicMessagesCompat): void {
	model.compat = { ...(model.compat as AnthropicMessagesCompat | undefined), ...compat };
}

function detectOpenAICompletionsCompat(model: Model<"openai-completions">): OpenAICompletionsResolvedCompat {
	const provider = model.provider;
	const baseUrl = model.baseUrl;

	const isZai =
		provider === "zai" ||
		provider === "zai-coding-cn" ||
		baseUrl.includes("api.z.ai") ||
		baseUrl.includes("open.bigmodel.cn");
	const isTogether =
		provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
	const isCerebras = provider === "cerebras" || baseUrl.includes("cerebras.ai");
	const isTogetherReasoningOnly = isTogether && TOGETHER_REASONING_ONLY_MODELS.has(model.id);
	const isDeepSeek = provider === "deepseek" || baseUrl.toLowerCase().includes("deepseek.com");

	const isNonStandard =
		isNvidia ||
		isCerebras ||
		provider === "xai" ||
		baseUrl.includes("api.x.ai") ||
		isTogether ||
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isZai ||
		isMoonshot ||
		provider === "opencode" ||
		baseUrl.includes("opencode.ai") ||
		isCloudflareWorkersAI ||
		isCloudflareAiGateway ||
		isAntLing;

	const useMaxTokens =
		baseUrl.includes("chutes.ai") ||
		isDeepSeek ||
		isMoonshot ||
		isCloudflareAiGateway ||
		isTogether ||
		isNvidia ||
		isAntLing ||
		isZai;

	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isOpenRouterDeveloperRoleModel =
		isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
	const openRouterCacheControlPrefixes = ["anthropic/", "qwen/", "google/"];
	const cacheControlModelId = model.id.startsWith("~") ? model.id.slice(1) : model.id;
	const supportsOpenRouterCacheControl = openRouterCacheControlPrefixes.some((prefix) =>
		cacheControlModelId.startsWith(prefix),
	);
	const cacheControlFormat = provider === "openrouter" && supportsOpenRouterCacheControl ? "anthropic" : undefined;

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || (!isNonStandard && !isOpenRouter),
		supportsReasoningEffort:
			!isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
		supportsUsageInStreaming: true,
		supportsFinishReason: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		thinkingFormat: isDeepSeek
			? "deepseek"
			: isZai
				? "zai"
				: isTogether && !isTogetherReasoningOnly
					? "together"
					: isAntLing
						? "ant-ling"
						: isOpenRouter
							? "openrouter"
							: "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		chatTemplateArgs: {},
		zaiToolStream: false,
		// Preserve built-in behavior as explicit metadata against the conservative runtime default.
		supportsStrictMode: !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isCerebras,
		supportsOpenAIGrammarTools: false,
		supportsMidConvoSystemMessages: false,
		supportsMidConvoToolAdditions: false,
		...(cacheControlFormat ? { cacheControlFormat } : {}),
		sendSessionAffinityHeaders: isOpenRouter,
		supportsPromptCacheKey: isMoonshot || baseUrl.includes("api.openai.com"),
		supportsLongCacheRetention: !(
			isTogether ||
			isCloudflareWorkersAI ||
			isCloudflareAiGateway ||
			isNvidia ||
			isAntLing
		),
	};
}

function isPlainEmptyObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function openAICompletionsCompatDelta(compat: OpenAICompletionsResolvedCompat): OpenAICompletionsCompat {
	const delta: OpenAICompletionsCompat = {};
	for (const [key, value] of Object.entries(compat)) {
		const defaultValue = OPENAI_COMPLETIONS_DEFAULT_COMPAT[key as keyof typeof OPENAI_COMPLETIONS_DEFAULT_COMPAT];
		if (isPlainEmptyObject(value) && isPlainEmptyObject(defaultValue)) continue;
		if (value !== defaultValue) {
			(delta as Record<string, unknown>)[key] = value;
		}
	}
	return delta;
}

function mergeOpenAICompletionsCompat(model: Model<Api>, compat: OpenAICompletionsCompat): void {
	model.compat = { ...(model.compat as OpenAICompletionsCompat | undefined), ...compat };
}

function applyOpenAICompletionsCompatMetadata(model: Model<Api>): void {
	if (model.api !== "openai-completions") return;
	const detected = openAICompletionsCompatDelta(detectOpenAICompletionsCompat(model as Model<"openai-completions">));
	model.compat = { ...detected, ...(model.compat as OpenAICompletionsCompat | undefined) };
	if (Object.keys(model.compat).length === 0) {
		delete model.compat;
	}
}

function applyAnthropicMessagesCompatMetadata(model: Model<Api>): void {
	if (model.api !== "anthropic-messages") return;
	const compat = getAnthropicMessagesCompat(model.provider, model.id);
	if (compat) {
		mergeAnthropicMessagesCompat(model, compat);
		if (compat.supportsMidConvoEffort) mergeThinkingLevelMap(model, { off: null });
	}
}

function isAnthropicFallbackMetadataModel(model: Model<Api>): model is Model<"anthropic-messages"> {
	if (model.provider !== "anthropic" || model.api !== "anthropic-messages") return false;
	return (
		model.id in ANTHROPIC_ALLOWED_FALLBACK_MODELS ||
		Object.values(ANTHROPIC_ALLOWED_FALLBACK_MODELS).some((fallbackModelIds) => fallbackModelIds.includes(model.id))
	);
}

function applyAnthropicAllowedFallbackModelMetadata(models: readonly Model<"anthropic-messages">[]): void {
	const modelsById = new Map(models.map((model) => [model.id, model]));
	for (const [modelId, fallbackModelIds] of Object.entries(ANTHROPIC_ALLOWED_FALLBACK_MODELS)) {
		const model = modelsById.get(modelId);
		if (!model) continue;

		const compatibleFallbackModelIds = model.compat?.supportsMidConvoEffort
			? fallbackModelIds.filter(supportsAnthropicMidConvoEffort)
			: fallbackModelIds;
		const allowedFallbackModels = compatibleFallbackModelIds.flatMap((fallbackModelId) => {
			const fallbackModel = modelsById.get(fallbackModelId);
			return fallbackModel
				? [{ provider: fallbackModel.provider, model: fallbackModel.id, cost: fallbackModel.cost }]
				: [];
		});
		if (allowedFallbackModels.length > 0) {
			mergeAnthropicMessagesCompat(model, { allowedFallbackModels });
		}
	}
}

// Bedrock global cross-region inference profiles for OpenAI GPT-5.6 serve the same
// weights as the regional `openai.gpt-5.6-*` entries and accept `strict: true` tool
// schemas, but models.dev only reports `structured_output` on the regional IDs. Without
// this override a regeneration silently drops `compat.supportsStrictMode`, and
// `bedrock-converse-stream.ts` then rejects `strict: "require"` sampling and downgrades
// `strict: "prefer"` to an unconstrained schema.
const BEDROCK_STRICT_MODE_MODEL_IDS = new Set([
	"global.openai.gpt-5.6-luna",
	"global.openai.gpt-5.6-sol",
	"global.openai.gpt-5.6-terra",
]);

function applyStrictToolCompatMetadata(model: Model<Api>): void {
	if (
		(model.provider === "openai" || model.provider === "cloudflare-ai-gateway") &&
		model.api === "openai-responses"
	) {
		model.compat = { ...(model.compat as OpenAIResponsesCompat | undefined), supportsStrictMode: true };
	} else if (model.provider === "anthropic" && model.api === "anthropic-messages") {
		mergeAnthropicMessagesCompat(model, { supportsStrictTools: true });
	} else if (model.provider === "amazon-bedrock" && BEDROCK_STRICT_MODE_MODEL_IDS.has(model.id)) {
		model.compat = { ...(model.compat as BedrockCompat | undefined), supportsStrictMode: true };
	}
}

// Responses endpoints verified (OpenAI, ChatGPT Codex backend, GitHub Copilot,
// opencode zen) or documented (Azure OpenAI, Cloudflare AI Gateway) to pass
// OpenAI custom grammar tools through. OpenAI rejects `type: "custom"` tools
// for pre-GPT-5 models (gpt-4.x, gpt-4o, o-series).
const OPENAI_GRAMMAR_TOOL_PROVIDERS = new Set([
	"openai",
	"chatgpt-subscription",
	"azure-openai-responses",
	"github-copilot",
	"opencode",
	"cloudflare-ai-gateway",
]);
const OPENAI_GRAMMAR_TOOL_APIS = new Set<Api>([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
]);

function applyOpenAIGrammarToolCompatMetadata(model: Model<Api>): void {
	if (!OPENAI_GRAMMAR_TOOL_APIS.has(model.api) || !OPENAI_GRAMMAR_TOOL_PROVIDERS.has(model.provider)) return;
	const match = /^gpt-(\d+)/.exec(model.id);
	if (!match || Number(match[1]) < 5) return;
	model.compat = { ...(model.compat as OpenAIResponsesCompat | undefined), supportsOpenAIGrammarTools: true };
}

function applyOpenAIToolSearchMetadata(model: Model<Api>): void {
	const isOpenAIResponses = model.provider === "openai" && model.api === "openai-responses";
	const isChatGptSubscription = model.provider === "chatgpt-subscription" && model.api === "openai-codex-responses";
	if (!(isOpenAIResponses || isChatGptSubscription) || !OPENAI_TOOL_SEARCH_MODEL_IDS.has(model.id)) return;
	const supportsAdditionalTools =
		(isOpenAIResponses && OPENAI_ADDITIONAL_TOOLS_MODEL_IDS.has(model.id)) ||
		(isChatGptSubscription && CHATGPT_SUBSCRIPTION_ADDITIONAL_TOOLS_MODEL_IDS.has(model.id));
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		...(supportsAdditionalTools ? { supportsAdditionalTools: true } : {}),
		supportsToolSearch: true,
	};
}

// Moonshot Kimi K2.6/K2.7 accept system text after the conversation starts but reject
// tool-bearing system messages. Kimi K3 accepts both forms; Fireworks and OpenCode pass
// its tool-bearing form through. GitHub Copilot forwards K3 text but silently drops its
// tool-bearing message. DeepSeek V4 Pro and OpenAI models behind OpenRouter also accept
// plain system text in place.
function applyOpenAICompletionsTranscriptMetadata(model: Model<Api>): void {
	if (model.api !== "openai-completions") return;
	const isKimiK3 =
		(model.provider.startsWith("moonshot") && model.id === "kimi-k3") ||
		(model.provider === "fireworks" && model.id.includes("kimi-k3")) ||
		((model.provider === "opencode" || model.provider === "opencode-go") && model.id === "kimi-k3");
	const isMoonshotKimiK2 =
		model.provider.startsWith("moonshot") &&
		(model.id === "kimi-k2.6" || model.id === "kimi-k2.7-code" || model.id === "kimi-k2.7-code-highspeed");
	const isTextOnly =
		isMoonshotKimiK2 ||
		(model.provider === "github-copilot" && model.id === "kimi-k3") ||
		(model.provider === "deepseek" && model.id === "deepseek-v4-pro") ||
		(model.provider === "openrouter" &&
			model.id.startsWith("openai/") &&
			OPENAI_MID_CONVO_SYSTEM_MESSAGE_MODEL_IDS.has(model.id.slice("openai/".length)));
	if (!isKimiK3 && !isTextOnly) return;
	model.compat = {
		...(model.compat as OpenAICompletionsCompat | undefined),
		supportsMidConvoSystemMessages: true,
		...(isKimiK3 ? { supportsMidConvoToolAdditions: true } : {}),
	};
}

// Newer OpenAI Responses models accept developer messages after the conversation has started.
// OpenCode Zen, OpenCode Go, and GitHub Copilot pass both those messages and
// `additional_tools` items through to OpenAI unchanged; tool search is not verified
// through those proxies.
const OPENAI_RESPONSES_PROXY_PROVIDERS = new Set(["opencode", "opencode-go", "github-copilot"]);

function applyOpenAIResponsesTranscriptMetadata(model: Model<Api>): void {
	const isOpenAIResponses = model.provider === "openai" && model.api === "openai-responses";
	const isChatGptSubscription = model.provider === "chatgpt-subscription" && model.api === "openai-codex-responses";
	const isProxiedResponses =
		OPENAI_RESPONSES_PROXY_PROVIDERS.has(model.provider) && model.api === "openai-responses";
	if (
		!(isOpenAIResponses || isChatGptSubscription || isProxiedResponses) ||
		!OPENAI_MID_CONVO_SYSTEM_MESSAGE_MODEL_IDS.has(model.id)
	) {
		return;
	}
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		supportsMidConvoSystemMessages: true,
		...(isProxiedResponses ? { supportsAdditionalTools: true } : {}),
	};
}

// OpenAI charges prompt-cache writes starting with the GPT-5.6 family, and exactly
// those models accept `prompt_cache_options`; older models reject the parameter.
// The same family keeps the cache warm across tool-set changes by accepting
// `tool_choice: allowed_tools` with an unchanged `tools` list (senpi#2095).
// https://developers.openai.com/api/docs/guides/prompt-caching
function applyOpenAIExplicitPromptCacheMetadata(model: Model<Api>): void {
	if (model.provider !== "openai" || model.api !== "openai-responses") return;
	if (!(model.cost.cacheWrite > 0)) return;
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		supportsExplicitPromptCacheMode: true,
		supportsAllowedTools: true,
	};
}

// A `configuration_update` input item changes reasoning effort without discarding the cached
// prefix; a new top-level `reasoning.effort` reports `reasoning_effort_changed` and caches 0.
// The direct API accepts the item on the same GPT-5.6+ family that prices cache writes
// (measured 2026-09-24 on gpt-6-luna and gpt-5.6-luna). The Codex backend was verified on
// gpt-6-astra; gpt-6.1-sol joins because openai/codex's models.json flags exactly these two ids
// `supports_reasoning_effort_updates: true` (gpt-6-sol and gpt-6-luna are not flagged), so the
// ChatGPT subscription lane stays limited to those ids.
const CHATGPT_SUBSCRIPTION_CONFIGURATION_UPDATE_MODEL_IDS = new Set(["gpt-6-astra", "gpt-6.1-sol"]);

function applyOpenAIConfigurationUpdateMetadata(model: Model<Api>): void {
	const isOpenAI = model.provider === "openai" && model.api === "openai-responses" && model.cost.cacheWrite > 0;
	const isChatGptSubscription =
		model.provider === "chatgpt-subscription" &&
		model.api === "openai-codex-responses" &&
		CHATGPT_SUBSCRIPTION_CONFIGURATION_UPDATE_MODEL_IDS.has(model.id);
	if (!(isOpenAI || isChatGptSubscription)) return;
	model.compat = {
		...(model.compat as OpenAIResponsesCompat | undefined),
		supportsConfigurationUpdate: true,
	};
}

// Every catalog that ships a GPT-6 Astra entry declares the same context window.
// Upstream passthrough catalogs (opencode, openrouter, github-copilot,
// vercel-ai-gateway) otherwise inherit the documented 1,050,000 window while the
// first-party OpenAI catalogs carry the input cap, so the effective Astra budget
// changed with the provider that routed the request.
function applyGpt6ContextWindow(model: Model<Api>): void {
	const contextWindow = gpt6FamilyDefaultContextWindow(model.id);
	if (contextWindow === undefined) return;
	model.contextWindow = contextWindow;
}

const GPT_6_THINKING_LEVEL_APIS = new Set<Api>([
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"openai-completions",
]);

// The documented GPT-6 ladder is low/medium/high/xhigh/max with no `minimal`; Astra and GPT-6.1 Sol
// also omit `none` (GPT-6 guide, Limitations), so `off` stays whatever the provider rules set for
// GPT-6 Sol and Luna ("none" on the direct OpenAI provider, absent elsewhere) and is forced off for
// Astra and GPT-6.1 Sol.
function applyGpt6ThinkingLevels(model: Model<Api>): void {
	if (!isGpt6FamilyId(model.id) || !GPT_6_THINKING_LEVEL_APIS.has(model.api)) return;
	mergeThinkingLevelMap(model, {
		minimal: null,
		low: "low",
		medium: "medium",
		high: "high",
		xhigh: "xhigh",
		max: "max",
	});
	if (model.id.includes("gpt-6-astra") || isGpt61SolId(model.id)) {
		mergeThinkingLevelMap(model, { off: null });
	}
}

// Anthropic ephemeral entries have a hard five-minute lifetime; `ttl: "1h"`
// extends it to one hour. Only direct Anthropic is annotated so cache warming
// does not assume equivalent behavior through proxies.
// https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
const ANTHROPIC_PROMPT_CACHE: ModelPromptCache = { short: 300, long: 3600 };

function applyPromptCacheMetadata(model: Model<Api>): void {
	if (model.provider === "anthropic" && model.api === "anthropic-messages") {
		model.promptCache = ANTHROPIC_PROMPT_CACHE;
	}
	// Do not add OpenAI lifetimes yet. Before enabling warming for explicit
	// OpenAI caches, re-evaluate it using observed expiry, replay, and billing
	// behavior; a documented TTL alone does not establish full cache loss.
}

function applyImageInputMetadata(model: AnyModel): void {
	if (!model.input.includes("image")) return;

	const providerLimits: AnyModel["inputLimits"] =
		model.provider === "anthropic"
			? {
					maxRequestBytes: 32 * 1024 * 1024,
					images: { maxPerRequest: model.type !== "image" && model.contextWindow === 200000 ? 100 : 600 },
				}
			: model.provider === "amazon-bedrock"
				? { images: { maxPerMessage: 20 } }
				: model.provider === "openai"
					? { maxRequestBytes: 512 * 1024 * 1024, images: { maxPerRequest: 1500 } }
					: model.provider === "google"
						? { maxRequestBytes: 20 * 1024 * 1024, images: { maxPerRequest: 3600 } }
						: undefined;
	const configuredImages = model.inputLimits?.images;
	model.inputLimits = {
		...providerLimits,
		...model.inputLimits,
		images: {
			...providerLimits?.images,
			...configuredImages,
			resize: { ...DEFAULT_IMAGE_RESIZE, ...configuredImages?.resize },
		},
	};
}

function isGemma4Model(modelId: string): boolean {
	return /gemma-?4/.test(modelId.toLowerCase());
}

function getGoogleThinkingLevelMap(
	modelId: string,
	reasoningOptions: readonly ModelsDevReasoningOption[],
): NonNullable<Model<Api>["thinkingLevelMap"]> | undefined {
	const effortMap = getEffortThinkingLevelMap(reasoningOptions);
	if (effortMap) return effortMap;
	if (isGemma4Model(modelId)) {
		return { off: null, minimal: "MINIMAL", low: null, medium: null, high: "HIGH" };
	}
	return undefined;
}

function applyThinkingLevelMetadata(model: Model<any>): void {
	if (
		(model.api === "openai-responses" || model.api === "azure-openai-responses") &&
		model.id.startsWith("gpt-5")
	) {
		mergeThinkingLevelMap(model, { off: null });
	}
	if (
		(model.id === "gpt-6-astra" ||
			model.id === "gpt-6-sol" ||
			model.id === "gpt-6-luna" ||
			model.id === "gpt-6.1-sol") &&
		(model.api === "openai-responses" ||
			model.api === "azure-openai-responses" ||
			model.api === "openai-codex-responses")
	) {
		mergeThinkingLevelMap(model, {
			// GPT-6 Astra and GPT-6.1 Sol reject reasoning.effort "none".
			off: model.id === "gpt-6-astra" || model.id === "gpt-6.1-sol" ? null : "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		});
	}
	if (model.provider === "github-copilot" && model.id.startsWith("gpt-5")) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (
		model.api === "openai-responses" &&
		model.provider === "openai" &&
		OPENAI_RESPONSES_NONE_REASONING_MODELS.has(model.id)
	) {
		mergeThinkingLevelMap(model, { off: "none" });
	}
	// xAI models without verified effort options must not send the undocumented
	// "none"/"minimal" efforts.
	if (model.provider === "xai" && model.api === "openai-responses" && model.thinkingLevelMap === undefined) {
		mergeThinkingLevelMap(model, { off: null, minimal: null });
	}
	if (supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (supportsOpenAiMax(model)) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (model.provider === "openai" && model.id.startsWith("gpt-5.6")) {
		mergeThinkingLevelMap(model, { minimal: "minimal" });
	}
	if (model.provider === "openai" && model.id === "gpt-5.5") {
		mergeThinkingLevelMap(model, { minimal: null });
	}
	if (model.id.endsWith("gpt-5.5-pro")) {
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: null });
	}
	// Anthropic adaptive-thinking effort support (per Anthropic adaptive thinking docs):
	// - "max" is available on all adaptive-thinking Claude models.
	// - "xhigh" is available on Opus 4.7/4.8, Opus 5, Sonnet 5, and Fable 5.
	if (
		model.id.includes("opus-4-6") ||
		model.id.includes("opus-4.6") ||
		model.id.includes("sonnet-4-6") ||
		model.id.includes("sonnet-4.6")
	) {
		mergeThinkingLevelMap(model, { max: "max" });
	}
	if (
		model.id.includes("opus-4-7") ||
		model.id.includes("opus-4.7") ||
		model.id.includes("opus-4-8") ||
		model.id.includes("opus-4.8") ||
		model.id.includes("opus-5") ||
		model.id.includes("opus.5") ||
		model.id.includes("sonnet-5") ||
		model.id.includes("sonnet.5") ||
		model.id.includes("opus-5") ||
		model.id.includes("opus.5")
	) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh", max: "max" });
	}
	if (isAnthropicAdaptiveOnlyModel(model.id)) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh", max: "max" });
		if (model.api === "anthropic-messages") {
			// Fable 5 and Opus 5.5 reject `thinking: {type: "disabled"}` (verified 400: `"thinking.type.disabled"
			// is not supported for this model`) and default to adaptive thinking when the field is
			// omitted, so the Messages provider pins the cheapest effort for a thinking-off turn.
			// Encoding that as a compat fact instead of `thinkingLevelMap.off: null` keeps `off` a
			// selectable level while still keeping `thinking.type: "disabled"` off the wire.
			mergeAnthropicMessagesCompat(model, { supportsDisabledThinking: false });
		} else {
			mergeThinkingLevelMap(model, { off: null });
		}
	}
	if (model.api === "anthropic-messages" && isAnthropicAdaptiveThinkingModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { forceAdaptiveThinking: true });
	}
	if (model.api === "anthropic-messages" && isAnthropicTemperatureUnsupportedModel(model.id)) {
		mergeAnthropicMessagesCompat(model, { supportsTemperature: false });
	}
	if (
		model.api === "openai-completions" &&
		model.id.includes("deepseek-v4") &&
		model.thinkingLevelMap === undefined
	) {
		mergeThinkingLevelMap(
			model,
			model.provider === "openrouter"
				? { ...DEEPSEEK_V4_THINKING_LEVEL_MAP, xhigh: "xhigh", max: null }
				: (model.provider === "deepseek" || model.provider === "opencode" || model.provider === "opencode-go") &&
					model.id.includes("deepseek-v4-flash")
					? DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP
					: DEEPSEEK_V4_THINKING_LEVEL_MAP,
		);
	}
	if (model.provider === "groq" && model.id === "qwen/qwen3.6-27b") {
		mergeThinkingLevelMap(model, { minimal: null, low: null, medium: null, high: "default" });
	}
	if (model.provider === "chatgpt-subscription" && supportsOpenAiXhigh(model.id)) {
		mergeThinkingLevelMap(model, { minimal: "low" });
	}
	if (
		(model.provider === "moonshotai" || model.provider === "moonshotai-cn") &&
		(model.id === "kimi-k2.7-code" || model.id === "kimi-k2.7-code-highspeed")
	) {
		// Kimi K2.7 Code is always-thinking. Official docs say
		// `thinking: { type: "disabled" }` is rejected, and callers can omit
		// the thinking parameter to use the enabled default.
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "openrouter" && model.id.startsWith("inception/mercury-2")) {
		// Mercury 2 in instant mode (reasoning_effort: "none") disables tool calling.
		// Mark "off" unsupported so the openai-completions provider omits the reasoning param
		// instead of defaulting to {reasoning:{effort:"none"}} (see openai-completions.ts:575).
		// Pi's low/medium/high pass through verbatim; OpenRouter normalizes to Mercury's vocabulary.
		mergeThinkingLevelMap(model, { off: null });
	}
	if (model.provider === "openrouter" && (model.id === "z-ai/glm-5.2" || model.id === "z-ai/glm-5.3")) {
		mergeThinkingLevelMap(model, { xhigh: "xhigh" });
	}
	if (model.provider === "fireworks") {
		if (model.api === "anthropic-messages" && model.compat?.forceAdaptiveThinking) {
			// Qwen Max currently advertises only a toggle. Prefer upstream effort
			// metadata once available instead of replacing it with this fallback.
			if (model.id === "accounts/fireworks/models/qwen3p8-max" && !model.thinkingLevelMap) {
				model.thinkingLevelMap = getEffortThinkingLevelMap([
					{ type: "effort", values: ["low", "medium", "xhigh"] },
				]);
			}
			const reasoningOptions = modelsDevReasoningOptions.get(getModelKey(model));
			if (
				reasoningOptions?.some((option) => option.type === "toggle") ||
				// The 2.4T alias omits the verified toggle in models.dev.
				model.id === "accounts/fireworks/models/qwen3p8-2p4t-a95b"
			) {
				mergeThinkingLevelMap(model, { off: "none" });
			}
			if (model.id === "accounts/fireworks/models/deepseek-v4-pro-0813") {
				mergeThinkingLevelMap(model, { low: "low" });
			}
		}
		// GLM 5.2/5.3 and their fast routers support off/high/max. Fireworks maps low
		// and medium to high, so do not expose those aliases as distinct levels.
		if (model.id.includes("glm-5p2") || model.id.includes("glm-5p3")) {
			mergeThinkingLevelMap(model, { off: "none", minimal: null, low: null, medium: null, max: "max" });
		}
		if (model.id.includes("kimi-k3")) {
			// Fireworks maps medium to high on both APIs; do not expose it as a distinct level.
			mergeThinkingLevelMap(model, { medium: null });
		}
	}
	if (model.provider === "opencode-go" && (model.id === "glm-5.2" || model.id === "glm-5.3")) {
		mergeThinkingLevelMap(model, OPENCODE_GO_GLM52_THINKING_LEVEL_MAP);
	}
	if (model.provider === "opencode-go" && model.id === "kimi-k2.6") {
		// OpenCode Go exposes Kimi K2.6 thinking as on/off, not distinct effort tiers.
		mergeThinkingLevelMap(model, { minimal: null, low: null, medium: null });
	}
	if (model.provider === "opencode" && model.id === "grok-build-0.1") {
		// OpenCode Zen Grok Build reasons by default but rejects explicit reasoningEffort.
		mergeThinkingLevelMap(model, { off: null, minimal: null, low: null, medium: null });
	}
	if (model.provider === "ant-ling" && model.reasoning) {
		// Ring reasons by default. Only high/xhigh have documented explicit effort controls.
		mergeThinkingLevelMap(model, ANT_LING_RING_THINKING_LEVEL_MAP);
	}
	if (model.provider === "github-copilot") {
		const override = GITHUB_COPILOT_THINKING_LEVEL_OVERRIDES[model.id];
		if (override) {
			mergeThinkingLevelMap(model, override);
		}
	}
}

function getAnthropicMessagesCompat(provider: string, modelId: string): AnthropicMessagesCompat | undefined {
	const compat: AnthropicMessagesCompat = {};
	if (
		VERIFIED_ANTHROPIC_MID_CONVO_EFFORT_PROVIDERS.has(provider) &&
		supportsAnthropicMidConvoEffort(modelId) &&
		!MID_CONVO_EFFORT_UNSUPPORTED_ANTHROPIC_MODELS.has(`${provider}:${modelId}`)
	) {
		compat.supportsMidConvoEffort = true;
	}
	if (provider === "anthropic" && supportsAnthropicMidConvoSystemMessages(modelId)) {
		compat.supportsMidConvoSystemMessages = true;
		compat.supportsMidConvoToolChanges = true;
	}
	// OpenCode Zen and GitHub Copilot forward mid-conversation system messages but reject
	// `tool_addition`/`tool_removal` blocks, so tool changes stay top-level there.
	if ((provider === "opencode" || provider === "github-copilot") && supportsAnthropicMidConvoSystemMessages(modelId)) {
		compat.supportsMidConvoSystemMessages = true;
	}
	if (EAGER_TOOL_INPUT_STREAMING_UNSUPPORTED_ANTHROPIC_MODELS.has(`${provider}:${modelId}`)) {
		compat.supportsEagerToolInputStreaming = false;
	}
	if (provider === "xiaomi" || provider.startsWith("xiaomi-token-plan-")) {
		compat.allowEmptySignature = true;
	}
	// OpenCode Qwen 3.8 Flash emits and accepts thinking blocks with empty signatures.
	if ((provider === "opencode" || provider === "opencode-go") && modelId === "qwen3.8-flash") {
		compat.allowEmptySignature = true;
	}
	return Object.keys(compat).length > 0 ? compat : undefined;
}

function getBedrockBaseUrl(modelId: string): string {
	return modelId.startsWith("eu.")
		? "https://bedrock-runtime.eu-central-1.amazonaws.com"
		: "https://bedrock-runtime.us-east-1.amazonaws.com";
}

function normalizeNvidiaModelId(modelId: string): string {
	return modelId.toLowerCase().replaceAll("_", ".");
}

function roundCost(value: number): number {
	return Number(value.toFixed(6));
}

// Claude Haiku 5.5 bills the whole request at five times every base rate once the prompt exceeds 100K input
// tokens, on every route (https://platform.claude.com/docs/en/about-claude/pricing). Catalogs that list it
// with flat prices (regional Bedrock, batch variants, gateways) take the tier from their own base rates.
const CLAUDE_HAIKU_55_LONG_CONTEXT_INPUT_THRESHOLD = 100000;
const CLAUDE_HAIKU_55_BANDED_MAX_TOKENS = 32000;

function withClaudeHaiku55LongContextPricing(cost: ModelCost): ModelCost {
	if (cost.tiers?.length) return cost;
	return {
		...cost,
		tiers: [
			{
				inputTokensAbove: CLAUDE_HAIKU_55_LONG_CONTEXT_INPUT_THRESHOLD,
				input: roundCost(cost.input * 5),
				output: roundCost(cost.output * 5),
				cacheRead: roundCost(cost.cacheRead * 5),
				cacheWrite: roundCost(cost.cacheWrite * 5),
			},
		],
	};
}

function getModelsDevCost(cost: ModelsDevModel["cost"]): ModelCost {
	const tiers = cost?.tiers?.flatMap((tier) => {
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
		input: cost?.input || 0,
		output: cost?.output || 0,
		cacheRead: cost?.cache_read || 0,
		cacheWrite: cost?.cache_write || 0,
		...(tiers && tiers.length > 0 ? { tiers } : {}),
	};
}

async function fetchNvidiaNimModelIds(): Promise<Map<string, string>> {
	try {
		console.log("Fetching models from NVIDIA NIM API...");
		const response = await fetch(`${NVIDIA_BASE_URL}/models`);
		if (!response.ok) throw new Error(`NVIDIA NIM API returned ${response.status}`);
		const data = (await response.json()) as { data?: NvidiaNimModelListItem[] };
		const modelIds = new Map<string, string>();

		for (const model of data.data ?? []) {
			modelIds.set(model.id, model.id);
			modelIds.set(normalizeNvidiaModelId(model.id), model.id);
		}

		console.log(`Fetched ${data.data?.length ?? 0} model IDs from NVIDIA NIM`);
		return modelIds;
	} catch (error) {
		console.error("Failed to fetch NVIDIA NIM models:", error);
		if (generatorOptions.strict) throw error;
		return new Map();
	}
}

async function fetchOpenRouterList(query: string): Promise<OpenRouterModelListItem[]> {
	const response = await fetch(`https://openrouter.ai/api/v1/models${query}`);
	if (!response.ok) throw new Error(`OpenRouter API returned ${response.status}`);
	const data = (await response.json()) as { data?: OpenRouterModelListItem[] };
	return data.data ?? [];
}

async function fetchOpenRouterModels(): Promise<OpenRouterCatalog> {
	try {
		console.log("Fetching models from OpenRouter API...");
		const [listed, imageListed, decisionListed] = await Promise.all([
			fetchOpenRouterList(""),
			fetchOpenRouterList("?output_modalities=image"),
			fetchOpenRouterList("?output_modalities=decisions"),
		]);
		const catalog = buildOpenRouterCatalog(listed, imageListed, decisionListed);
		console.log(
			`Fetched ${catalog.chat.length} tool-capable, ${catalog.images.length} image, and ${catalog.classifiers.length} classifier models from OpenRouter`,
		);
		if (generatorOptions.strict && catalog.images.length === 0) {
			throw new Error("OpenRouter API returned no usable image models");
		}
		return catalog;
	} catch (error) {
		console.error("Failed to fetch OpenRouter models:", error);
		if (generatorOptions.strict) throw error;
		return { chat: [], images: [], classifiers: [] };
	}
}

async function fetchRadiusModels(): Promise<Model<"pi-messages">[]> {
	try {
		console.log("Fetching models from Radius API...");
		const config = await loadRadiusGatewayConfig(DEFAULT_RADIUS_GATEWAY);
		const models = getRadiusModelsFromConfig("radius", config);
		if (models.length === 0) throw new Error("Radius API returned no models");
		console.log(`Fetched ${models.length} models from Radius`);
		return models;
	} catch (error) {
		console.error("Failed to fetch Radius models:", error);
		if (generatorOptions.strict) throw error;
		return [];
	}
}

async function fetchAiGatewayModels(): Promise<{
	chat: Model<any>[];
	classifiers: ClassifierModel<"typesafe-system-one">[];
}> {
	try {
		console.log("Fetching models from Vercel AI Gateway API...");
		const response = await fetch(`${AI_GATEWAY_MODELS_URL}/models`);
		if (!response.ok) throw new Error(`Vercel AI Gateway API returned ${response.status}`);
		const data = await response.json();
		const models: Model<any>[] = [];
		const classifiers: ClassifierModel<"typesafe-system-one">[] = [];

		const toNumber = (value: string | number | undefined): number => {
			if (typeof value === "number") {
				return Number.isFinite(value) ? value : 0;
			}
			const parsed = parseFloat(value ?? "0");
			return Number.isFinite(parsed) ? parsed : 0;
		};

		const items = Array.isArray(data.data) ? (data.data as AiGatewayModel[]) : [];
		for (const model of items) {
			// Evaluation models such as TypeSafe's Jev are served through the
			// TypeSafe-compatible System One endpoint.
			if (model.type === "evaluation") {
				classifiers.push({
					type: "classifier",
					id: model.id,
					name: model.name || model.id,
					api: "typesafe-system-one",
					provider: "vercel-ai-gateway",
					baseUrl: AI_GATEWAY_TYPESAFE_BASE_URL,
					input: ["text"],
					cost: {
						input: roundCost(toNumber(model.pricing?.input) * 1_000_000),
						output: roundCost(toNumber(model.pricing?.output) * 1_000_000),
						cacheRead: 0,
						cacheWrite: 0,
					},
					contextWindow: model.context_window || 4096,
				});
				continue;
			}
			const tags = Array.isArray(model.tags) ? model.tags : [];
			// Only include models that support tools
			if (!tags.includes("tool-use")) continue;

			const input: ("text" | "image")[] = ["text"];
			if (tags.includes("vision")) {
				input.push("image");
			}

			const inputCost = roundCost(toNumber(model.pricing?.input) * 1_000_000);
			const outputCost = roundCost(toNumber(model.pricing?.output) * 1_000_000);
			const cacheReadCost = roundCost(toNumber(model.pricing?.input_cache_read) * 1_000_000);
			const cacheWriteCost = roundCost(toNumber(model.pricing?.input_cache_write) * 1_000_000);

			models.push({
				id: model.id,
				name: model.name || model.id,
				api: "anthropic-messages",
				baseUrl: AI_GATEWAY_BASE_URL,
				provider: "vercel-ai-gateway",
				reasoning: tags.includes("reasoning"),
				input,
				compat: { allowEmptySignature: true },
				cost: {
					input: inputCost,
					output: outputCost,
					cacheRead: cacheReadCost,
					cacheWrite: cacheWriteCost,
				},
				contextWindow: model.context_window || 4096,
				maxTokens: model.max_tokens || 4096,
			});
		}

		console.log(
			`Fetched ${models.length} tool-capable and ${classifiers.length} classifier models from Vercel AI Gateway`,
		);
		return { chat: models, classifiers };
	} catch (error) {
		console.error("Failed to fetch Vercel AI Gateway models:", error);
		if (generatorOptions.strict) throw error;
		return { chat: [], classifiers: [] };
	}
}

function processZaiModels(data: ModelsDevCatalog): Model<Api>[] {
	const variants = [
		{
			source: "zai-coding-plan",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
		},
		{
			source: "zhipuai-coding-plan",
			provider: "zai-coding-cn",
			baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		},
	] as const;
	const models: Model<Api>[] = [];

	for (const { source, provider, baseUrl } of variants) {
		for (const [modelId, model] of Object.entries(data[source]?.models ?? {})) {
			const m = model as ModelsDevModel;
			if (m.tool_call !== true) continue;
			const supportsImage = m.modalities?.input?.includes("image");

			const isGlm52 = modelId === "glm-5.2" || modelId === "glm-5.2-highspeed";
			const thinkingLevelMap = isGlm52
				? { off: "none", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null }
				: getEffortThinkingLevelMap(m.reasoning_options ?? []);
			const supportsReasoningEffort = thinkingLevelMap !== undefined;
			const referenceCost = data.zai?.models[modelId]?.cost ?? m.cost;

			models.push({
				id: modelId,
				name: m.name || modelId,
				api: "openai-completions",
				provider,
				baseUrl,
				reasoning: m.reasoning === true,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: supportsImage ? ["text", "image"] : ["text"],
				cost: {
					input: referenceCost?.input || 0,
					output: referenceCost?.output || 0,
					cacheRead: referenceCost?.cache_read || 0,
					cacheWrite: referenceCost?.cache_write || 0,
				},
				compat: {
					supportsDeveloperRole: false,
					thinkingFormat: "zai",
					...(supportsReasoningEffort ? { supportsReasoningEffort: true } : {}),
					...(!ZAI_TOOL_STREAM_UNSUPPORTED_MODELS.has(modelId) ? { zaiToolStream: true } : {}),
				},
				contextWindow: m.limit?.context || 4096,
				maxTokens: m.limit?.output || 4096,
			});
			recordModelsDevReasoningOptions(provider, modelId, m);
		}
	}

	return models;
}

function processBasetenModels(provider: ModelsDevProvider | undefined): Model<Api>[] {
	if (!provider?.models) return [];

	const baseUrl = "https://inference.baseten.co/v1";
	const baseCompat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
		supportsStrictMode: true,
		// Baseten automatic prompt caching needs session affinity so related
		// requests land on the same replica. See:
		// https://docs.baseten.co/inference/model-apis/pricing-and-limits
		sendSessionAffinityHeaders: true,
		supportsLongCacheRetention: false,
	};
	const reasoningEffortCompat: OpenAICompletionsCompat = {
		...baseCompat,
		supportsReasoningEffort: true,
		thinkingFormat: "openai",
	};
	const toggleReasoningCompat: OpenAICompletionsCompat = {
		...baseCompat,
		thinkingFormat: "baseten",
		chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
	};
	const toggleReasoningEffortCompat: OpenAICompletionsCompat = {
		...reasoningEffortCompat,
		thinkingFormat: "baseten",
		chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
	};
	const toggleThinkingLevelMap = {
		off: "off",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: null,
	} as const;
	const glm52ThinkingLevelMap = {
		off: "none",
		minimal: null,
		low: null,
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	} as const;
	const models: Model<Api>[] = [];

	for (const [modelId, model] of Object.entries(provider.models)) {
		if (model.status === "deprecated") continue;

		const reasoning = model.reasoning === true;
		const reasoningOptions = model.reasoning_options ?? [];
		const isGlm52 = modelId === "zai-org/GLM-5.2" || modelId === "zai-org/GLM-5.2-Fast";
		const supportsToggle = reasoningOptions.some((option) => option.type === "toggle") || isGlm52;
		const supportsEffort = reasoningOptions.some((option) => option.type === "effort") || isGlm52;
		const compat =
			supportsToggle && supportsEffort
				? toggleReasoningEffortCompat
				: supportsToggle
					? toggleReasoningCompat
					: supportsEffort
						? reasoningEffortCompat
						: baseCompat;
		const thinkingLevelMap = isGlm52
			? glm52ThinkingLevelMap
			: supportsToggle
				? toggleThinkingLevelMap
				: getEffortThinkingLevelMap(reasoningOptions);
		// Baseten's GLM-5.2 endpoints are text-only despite models.dev reporting image input.
		const supportsImageInput = !isGlm52 && model.modalities?.input?.includes("image");

		models.push({
			id: modelId,
			name: model.name || modelId,
			api: "openai-completions",
			provider: "baseten",
			baseUrl,
			reasoning,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			input: supportsImageInput ? ["text", "image"] : ["text"],
			cost: {
				input: model.cost?.input || 0,
				output: model.cost?.output || 0,
				cacheRead: model.cost?.cache_read || 0,
				cacheWrite: model.cost?.cache_write || 0,
			},
			compat,
			contextWindow: model.limit?.context || 4096,
			maxTokens: model.limit?.output || 4096,
		});
	}

	return models;
}

function processGoogleModels(data: ModelsDevCatalog): Model<Api>[] {
	const models: Model<Api>[] = [];
	const googleModels = data.google?.models;
	if (googleModels) {
		for (const [modelId, model] of Object.entries(googleModels)) {
			if (model.tool_call !== true) continue;
			const source =
				modelId === "gemini-flash-latest"
					? (googleModels["gemini-3.5-flash"] ?? model)
					: modelId === "gemini-flash-lite-latest"
						? (googleModels["gemini-3.1-flash-lite"] ?? model)
						: model;
			const thinkingLevelMap = getGoogleThinkingLevelMap(modelId, source.reasoning_options ?? []);

			models.push({
				id: modelId,
				name: model.name || modelId,
				api: "google-generative-ai",
				provider: "google",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				reasoning: source.reasoning === true,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: source.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: {
					input: source.cost?.input || 0,
					output: source.cost?.output || 0,
					cacheRead: source.cost?.cache_read || 0,
					cacheWrite: source.cost?.cache_write || 0,
				},
				contextWindow: source.limit?.context || 4096,
				maxTokens: source.limit?.output || 4096,
			});
		}
	}

	// The google-vertex models.dev catalog also includes Claude, OpenAI, and other
	// MaaS models that do not use the @google/genai Gemini streaming path.
	const vertexModels = data["google-vertex"]?.models;
	if (vertexModels) {
		for (const [modelId, model] of Object.entries(vertexModels)) {
			if (model.tool_call !== true || !modelId.startsWith("gemini-")) continue;
			if (modelId === "gemini-3.1-flash-lite-preview") continue;
			const source =
				modelId === "gemini-flash-latest"
					? (vertexModels["gemini-3.5-flash"] ?? model)
					: modelId === "gemini-flash-lite-latest"
						? (vertexModels["gemini-3.1-flash-lite"] ?? model)
						: model;
			const thinkingLevelMap = getGoogleThinkingLevelMap(modelId, source.reasoning_options ?? []);
			// models.dev reports Vertex cache_read/cache_write values for Gemini 2.5 Flash that
			// do not match the official Gemini API standard pricing table. pi only accounts
			// cachedContentTokenCount as cacheRead.
			const cacheRead = modelId === "gemini-2.5-flash" ? 0.03 : source.cost?.cache_read || 0;

			models.push({
				id: modelId,
				name: model.name || modelId,
				api: "google-vertex",
				provider: "google-vertex",
				baseUrl: VERTEX_BASE_URL,
				reasoning: source.reasoning === true,
				...(thinkingLevelMap ? { thinkingLevelMap } : {}),
				input: source.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				cost: {
					input: source.cost?.input || 0,
					output: source.cost?.output || 0,
					cacheRead,
					cacheWrite: 0,
				},
				contextWindow: source.limit?.context || 4096,
				maxTokens: source.limit?.output || 4096,
			});
		}
	}

	return models;
}

function processFireworksModels(provider: ModelsDevProvider | undefined): Model<Api>[] {
	if (!provider?.models) return [];

	const anthropicCompat: AnthropicMessagesCompat = {
		// Arbitrary loader names work, but Fireworks only defers the prefix for ToolSearch/tool_search.
		supportsToolReferences: true,
		allowEmptySignature: true,
		sendSessionAffinityHeaders: true,
		supportsEagerToolInputStreaming: false,
		supportsCacheControlOnTools: false,
		supportsLongCacheRetention: false,
	};
	const openAICompat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		sendSessionAffinityHeaders: true,
		supportsLongCacheRetention: false,
	};
	const kimiK3Compat: OpenAICompletionsCompat = {
		...openAICompat,
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "openai",
	};
	const models: Model<Api>[] = [];

	for (const [modelId, model] of Object.entries(provider.models)) {
		if (model.tool_call !== true) continue;

		const input: ("text" | "image")[] = model.modalities?.input?.includes("image")
			? ["text", "image"]
			: ["text"];
		const common = {
			id: modelId,
			name: model.name || modelId,
			provider: "fireworks",
			reasoning: model.reasoning === true,
			input,
			cost: {
				input: model.cost?.input || 0,
				output: model.cost?.output || 0,
				cacheRead: model.cost?.cache_read || 0,
				cacheWrite: model.cost?.cache_write || 0,
			},
			contextWindow: model.limit?.context || 4096,
			maxTokens: model.limit?.output || 4096,
		};

		if (modelId.includes("glm-")) {
			models.push({
				...common,
				api: "openai-completions",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				compat: openAICompat,
			});
		} else if (modelId.includes("kimi-k3")) {
			models.push({
				...common,
				api: "openai-completions",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				compat: kimiK3Compat,
			});
		} else {
			models.push({
				...common,
				api: "anthropic-messages",
				// Fireworks Anthropic-compatible API - SDK appends /v1/messages.
				baseUrl: "https://api.fireworks.ai/inference",
				// Fireworks prompt caching uses automatic prefix matching + session affinity.
				// x-session-affinity routes requests to the same replica for cache hits.
				// cache_control on tools and eager_input_streaming are not supported.
				// See: https://docs.fireworks.ai/tools-sdks/anthropic-compatibility
				// Use adaptive thinking for cataloged effort controls, with verified
				// fallbacks where models.dev is incomplete. New models need no allowlist entry.
				compat: {
					...anthropicCompat,
					...(model.reasoning_options?.some((option) => option.type === "effort") ||
					FIREWORKS_ADAPTIVE_THINKING_FALLBACK_MODELS.has(modelId)
						? { forceAdaptiveThinking: true }
						: {}),
				},
			});
		}
		recordModelsDevReasoningOptions("fireworks", modelId, model);
	}

	return models;
}

async function loadModelsDevData(): Promise<Model<any>[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetch("https://models.dev/api.json");
		if (!response.ok) throw new Error(`models.dev API returned ${response.status}`);
		const data = (await response.json()) as ModelsDevCatalog;

		const models: Model<any>[] = [];
		const nvidiaNimModelIds = data.nvidia?.models ? await fetchNvidiaNimModelIds() : new Map<string, string>();

		// Process Amazon Bedrock models
		if (data["amazon-bedrock"]?.models) {
			for (const [modelId, model] of Object.entries(data["amazon-bedrock"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (BEDROCK_INFERENCE_PROFILE_ONLY_MODEL_IDS.has(modelId)) continue;

				let id = modelId;

				if (id.startsWith("ai21.jamba")) {
					// These models doesn't support tool use in streaming mode
					continue;
				}

				if (id.startsWith("mistral.mistral-7b-instruct-v0")) {
					// These models doesn't support system messages
					continue;
				}

				models.push({
					id,
					name: m.name || id,
					api: "bedrock-converse-stream" as const,
					provider: "amazon-bedrock" as const,
					baseUrl: getBedrockBaseUrl(id),
					reasoning: m.reasoning === true,
					input: (m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"]) as ("text" | "image")[],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					...(m.structured_output === true && { compat: { supportsStrictMode: true } }),
				});
				recordModelsDevReasoningOptions("amazon-bedrock" as const, id, m);
			}
		}

		// Process Anthropic models
		if (data.anthropic?.models) {
			for (const [modelId, model] of Object.entries(data.anthropic.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.anthropic.com",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("anthropic", modelId, m);
			}
		}

		models.push(...processGoogleModels(data));

		// Process OpenAI models
		if (data.openai?.models) {
			for (const [modelId, model] of Object.entries(data.openai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				// models.dev lists this alias, but it is not accepted by OpenAI APIs.
				if (MODELS_DEV_OPENAI_UNSUPPORTED_MODEL_IDS.has(modelId)) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "openai",
					baseUrl: "https://api.openai.com/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("openai", modelId, m);
			}
		}

		// Process Groq models
		if (data.groq?.models) {
			for (const [modelId, model] of Object.entries(data.groq.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "groq",
					baseUrl: "https://api.groq.com/openai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("groq", modelId, m);
			}
		}

		// Process Cerebras models
		if (data.cerebras?.models) {
			for (const [modelId, model] of Object.entries(data.cerebras.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cerebras",
					baseUrl: "https://api.cerebras.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("cerebras", modelId, m);
			}
		}

		// Process Cloudflare Workers AI models
		if (data["cloudflare-workers-ai"]?.models) {
			for (const [modelId, model] of Object.entries(data["cloudflare-workers-ai"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cloudflare-workers-ai",
					baseUrl: CLOUDFLARE_WORKERS_AI_BASE_URL,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat: { sendSessionAffinityHeaders: true },
				});
				recordModelsDevReasoningOptions("cloudflare-workers-ai", modelId, m);
			}
		}

		// Process Cloudflare AI Gateway models
		if (data["cloudflare-ai-gateway"]?.models) {
			for (const [prefixedId, model] of Object.entries(data["cloudflare-ai-gateway"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				const slashIdx = prefixedId.indexOf("/");
				if (slashIdx === -1) continue;
				const upstream = prefixedId.slice(0, slashIdx);
				const nativeId = prefixedId.slice(slashIdx + 1);

				let api: "anthropic-messages" | "openai-completions" | "openai-responses";
				let baseUrl: string;
				let id: string;
				if (upstream === "openai") {
					api = "openai-responses";
					baseUrl = CLOUDFLARE_AI_GATEWAY_OPENAI_BASE_URL;
					id = nativeId;
				} else if (upstream === "anthropic") {
					api = "anthropic-messages";
					baseUrl = CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL;
					id = nativeId;
				} else if (upstream === "workers-ai") {
					api = "openai-completions";
					baseUrl = CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL;
					id = prefixedId;
				} else {
					continue;
				}

				// Gateway passthroughs forward session affinity headers to upstreams that
				// use them for cache/routing affinity.
				const compat =
					upstream === "anthropic" || upstream === "workers-ai" ? { sendSessionAffinityHeaders: true } : undefined;

				models.push({
					id,
					name: m.name || id,
					api,
					provider: "cloudflare-ai-gateway",
					baseUrl,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					...(compat ? { compat } : {}),
				});
				recordModelsDevReasoningOptions("cloudflare-ai-gateway", id, m);
			}
		}

		// The gateway proxies Workers AI through its OpenAI-compatible /compat endpoint,
		// but models.dev may omit or intermittently drop those `workers-ai/*` entries
		// from the AI Gateway catalog. Mirror the Workers AI catalog under the documented
		// prefix so the gateway keeps its OpenAI-compatible models stable.
		if (data["cloudflare-workers-ai"]?.models) {
			for (const [modelId, model] of Object.entries(data["cloudflare-workers-ai"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				models.push({
					id: `workers-ai/${modelId}`,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "cloudflare-ai-gateway",
					baseUrl: CLOUDFLARE_AI_GATEWAY_COMPAT_BASE_URL,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat: { sendSessionAffinityHeaders: true },
				});
			}
		}

		// Process xAi models
		if (data.xai?.models) {
			for (const [modelId, model] of Object.entries(data.xai.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				const thinkingLevelMap = XAI_THINKING_LEVEL_MAPS[modelId];

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "xai",
					baseUrl: "https://api.x.ai/v1",
					compat: { ...XAI_RESPONSES_COMPAT },
					reasoning: m.reasoning === true,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("xai", modelId, m);
			}
		}

		// Process Meta models
		if (data.meta?.models) {
			for (const [modelId, model] of Object.entries(data.meta.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-responses",
					provider: "meta",
					baseUrl: "https://api.meta.ai/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("meta", modelId, m);
			}
		}

		// Process zAi models
		const zaiCodingPlanVariants = [
			{
				source: "zai-coding-plan",
				provider: "zai",
				baseUrl: "https://api.z.ai/api/coding/paas/v4",
			},
			{
				source: "zhipuai-coding-plan",
				provider: "zai-coding-cn",
				baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
			},
		] as const;

		for (const { source, provider, baseUrl } of zaiCodingPlanVariants) {
			for (const [modelId, model] of Object.entries(data[source]?.models ?? {})) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				const supportsImage = m.modalities?.input?.includes("image");

				const isGlm52 = modelId === "glm-5.2" || modelId === "glm-5.2-highspeed";
				const isGlm5x = isGlm52 || /^(?:glm-5\.3)(?:-(?:flash|highspeed))?$/.test(modelId);
				const referenceCost = modelId === "glm-5.2-highspeed" ? undefined : data.zai?.models[modelId]?.cost ?? m.cost;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					reasoning: m.reasoning === true,
					...(isGlm52
						? { thinkingLevelMap: ZAI_GLM52_THINKING_LEVEL_MAP }
						: isGlm5x
							? { thinkingLevelMap: getEffortThinkingLevelMap(m.reasoning_options ?? []) }
							: {}),
					input: supportsImage ? ["text", "image"] : ["text"],
					cost: {
						input: referenceCost?.input || 0,
						output: referenceCost?.output || 0,
						cacheRead: referenceCost?.cache_read || 0,
						cacheWrite: referenceCost?.cache_write || 0,
					},
					compat: {
						supportsDeveloperRole: false,
						thinkingFormat: "zai",
						...(isGlm5x ? { supportsReasoningEffort: true } : {}),
						...(!ZAI_TOOL_STREAM_UNSUPPORTED_MODELS.has(modelId) ? { zaiToolStream: true } : {}),
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions(provider, modelId, m);
			}
		}

		// Process Mistral models
		if (data.mistral?.models) {
			for (const [modelId, model] of Object.entries(data.mistral.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				// Models with effort values use `reasoning_effort` with these levels.
				// Reasoning models without them (Magistral) use `prompt_mode`.
				const thinkingLevelMap = getEffortThinkingLevelMap(m.reasoning_options ?? []);

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "mistral-conversations",
					provider: "mistral",
					baseUrl: "https://api.mistral.ai",
					reasoning: m.reasoning === true,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read ?? (m.cost?.input ? roundCost(m.cost.input * 0.1) : 0),
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		// Process Hugging Face models
		if (data.huggingface?.models) {
			for (const [modelId, model] of Object.entries(data.huggingface.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "huggingface",
					baseUrl: "https://router.huggingface.co/v1",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					compat: {
						supportsDeveloperRole: false,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("huggingface", modelId, m);
			}
		}

		models.push(...processFireworksModels(data["fireworks-ai"]));

		// Process NVIDIA NIM models
		if (data.nvidia?.models) {
			for (const [modelId, model] of Object.entries(data.nvidia.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (!m.modalities?.input?.includes("text")) continue;
				if (!m.modalities?.output?.includes("text")) continue;

				const liveModelId = nvidiaNimModelIds.get(modelId) ?? nvidiaNimModelIds.get(normalizeNvidiaModelId(modelId));
				if (!liveModelId) continue;
				if (NVIDIA_NIM_UNSUPPORTED_MODELS.has(liveModelId)) continue;

				models.push({
					id: liveModelId,
					name: m.name || liveModelId,
					api: "openai-completions",
					provider: "nvidia",
					baseUrl: NVIDIA_BASE_URL,
					headers: { ...NVIDIA_HEADERS },
					reasoning: m.reasoning === true,
					input: m.modalities.input.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					compat: NVIDIA_OPENAI_COMPAT,
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("nvidia", liveModelId, m);
			}
		}

		// Process Together AI models
		const togetherProvider = data.together ?? data.togetherai ?? data["together-ai"];
		if (togetherProvider?.models) {
			for (const [modelId, model] of Object.entries(togetherProvider.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				const reasoning = m.reasoning === true;
				const thinkingLevelMap = getTogetherThinkingLevelMap(modelId, reasoning);
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "together",
					baseUrl: TOGETHER_BASE_URL,
					reasoning,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					compat: getTogetherCompat(modelId, reasoning),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("together", modelId, m);
			}
		}

		models.push(...processBasetenModels(data.baseten));

		// Process Venice AI models
		if (data.venice?.models) {
			for (const [modelId, model] of Object.entries(data.venice.models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "venice",
					baseUrl: VENICE_BASE_URL,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					compat: { ...VENICE_COMPAT },
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("venice", modelId, m);
			}
		}

		// Process OpenCode models (Zen and Go)
		// API mapping based on provider.npm field:
		// - @ai-sdk/openai → openai-responses
		// - @ai-sdk/anthropic → anthropic-messages
		// - @ai-sdk/google → google-generative-ai
		// - null/undefined/@ai-sdk/openai-compatible → openai-completions
		const opencodeVariants = [
			{ key: "opencode", provider: "opencode", basePath: "https://opencode.ai/zen" },
			{ key: "opencode-go", provider: "opencode-go", basePath: "https://opencode.ai/zen/go" },
		] as const;

		for (const variant of opencodeVariants) {
			if (!data[variant.key]?.models) continue;

			for (const [modelId, model] of Object.entries(data[variant.key].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				const npm = m.provider?.npm;
				let api: Api;
				let baseUrl: string;
				let compat: OpenAICompletionsCompat | OpenAIResponsesCompat | undefined;

				if (npm === "@ai-sdk/openai") {
					api = "openai-responses";
					baseUrl = `${variant.basePath}/v1`;
					compat = { sessionAffinityFormat: "openai-nosession" };
				} else if (npm === "@ai-sdk/anthropic") {
					api = "anthropic-messages";
					// Anthropic SDK appends /v1/messages to baseURL
					baseUrl = variant.basePath;
				} else if (npm === "@ai-sdk/google") {
					api = "google-generative-ai";
					baseUrl = `${variant.basePath}/v1`;
				} else if (npm === "@ai-sdk/alibaba") {
					api = "openai-completions";
					baseUrl = `${variant.basePath}/v1`;
					compat = { cacheControlFormat: "anthropic" };
				} else {
					// null, undefined, or @ai-sdk/openai-compatible
					api = "openai-completions";
					baseUrl = `${variant.basePath}/v1`;
				}

				if (variant.provider === "opencode" && modelId === "grok-build-0.1") {
					compat = { ...(compat ?? {}), supportsReasoningEffort: false };
				}

				if ((variant.provider === "opencode" || variant.provider === "opencode-go") && modelId === "kimi-k2.6") {
					// OpenCode Kimi K2.6 accepts Anthropic-style thinking objects
					// and rejects string thinking values or combined reasoning_effort.
					compat = { ...(compat ?? {}), thinkingFormat: "deepseek", supportsReasoningEffort: false };
				}

				// Fix known mismatches between models.dev npm data and actual
				// OpenCode Go endpoint behaviour. models.dev reports these models
				// as @ai-sdk/anthropic, but the OpenCode Go endpoints either don't
				// accept Anthropic SDK auth (MiniMax M2.7) or are served through
				// the OpenAI-compatible /v1/chat/completions path (Qwen 3.5/3.6).
				// Switch them to openai-completions so requests use Bearer auth
				// and the standard /v1/chat/completions endpoint.
				if (variant.provider === "opencode-go") {
					if (modelId === "minimax-m2.7") {
						api = "openai-completions";
						baseUrl = `${variant.basePath}/v1`;
					}
					if (modelId === "qwen3.5-plus" || modelId === "qwen3.6-plus") {
						api = "openai-completions";
						baseUrl = `${variant.basePath}/v1`;
						// Qwen/DashScope uses enable_thinking at the top level.
						compat = { ...(compat ?? {}), thinkingFormat: "qwen" };
					}
				}

				if (api === "openai-completions") {
					compat = { ...(compat ?? {}), maxTokensField: "max_tokens" };
					if (
						OPENCODE_OPENAI_COMPLETIONS_LONG_CACHE_RETENTION_UNSUPPORTED_MODELS.has(
							`${variant.provider}:${modelId}`,
						)
					) {
						compat = { ...compat, supportsLongCacheRetention: false };
					}
				}

				let thinkingLevelMap: NonNullable<Model<Api>["thinkingLevelMap"]> | undefined;
				if (api === "google-generative-ai") {
					thinkingLevelMap = getGoogleThinkingLevelMap(modelId, m.reasoning_options ?? []);
				} else if (variant.provider === "opencode-go" && modelId === "deepseek-v4.1-flash") {
					thinkingLevelMap = getEffortThinkingLevelMap(m.reasoning_options ?? []);
				}
				models.push({
					id: modelId,
					name: m.name || modelId,
					api,
					provider: variant.provider,
					baseUrl,
					reasoning: m.reasoning === true,
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					...(compat ? { compat } : {}),
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions(variant.provider, modelId, m);
			}
		}

		// Process GitHub Copilot models
		if (data["github-copilot"]?.models) {
			for (const [modelId, model] of Object.entries(data["github-copilot"].models)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				// Claude 4.x and 5.x models route to Anthropic Messages API
				const isCopilotClaude = /^claude-(haiku|sonnet|opus|fable)-[45]([.\-]|$)/.test(modelId);
				// GPT, Grok, OSWE, and MAI-Code models are only served through
				// the Copilot /responses endpoint.
				const needsResponsesApi =
					modelId.startsWith("gpt-") ||
					modelId.startsWith("grok-") ||
					modelId.startsWith("oswe") ||
					modelId.startsWith("mai-");

				const api: Api = isCopilotClaude
					? "anthropic-messages"
					: needsResponsesApi
						? "openai-responses"
						: "openai-completions";

				const anthropicCompat =
					api === "anthropic-messages" ? getAnthropicMessagesCompat("github-copilot", modelId) : undefined;

				const copilotModel: Model<any> = {
					id: modelId,
					name: m.name || modelId,
					api,
					provider: "github-copilot",
					baseUrl: "https://api.individual.githubcopilot.com",
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: getModelsDevCost(m.cost),
					contextWindow: m.limit?.context || 128000,
					maxTokens: m.limit?.output || 8192,
					headers: { ...COPILOT_STATIC_HEADERS },
					...(anthropicCompat ? { compat: anthropicCompat } : {}),
					// compat only applies to openai-completions
					...(api === "openai-completions" ? {
						compat: {
							supportsStore: false,
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
						},
					} : {}),
				};

				models.push(copilotModel);
				recordModelsDevReasoningOptions("github-copilot", modelId, m);
			}
		}

		// Process MiniMax models
		const minimaxVariants = [
			{ key: "minimax", provider: "minimax", baseUrl: "https://api.minimax.io/anthropic" },
			{ key: "minimax-cn", provider: "minimax-cn", baseUrl: "https://api.minimaxi.com/anthropic" },
		] as const;

		for (const { key, provider, baseUrl } of minimaxVariants) {
			if (data[key]?.models) {
				for (const [modelId, model] of Object.entries(data[key].models)) {
					const m = model as ModelsDevModel;
					if (m.tool_call !== true) continue;

					models.push({
						id: modelId,
						name: m.name || modelId,
						api: "anthropic-messages",
						provider,
						// MiniMax's Anthropic-compatible API - SDK appends /v1/messages
						baseUrl,
						reasoning: m.reasoning === true,
						input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
						cost: {
							input: m.cost?.input || 0,
							output: m.cost?.output || 0,
							cacheRead: m.cost?.cache_read || 0,
							cacheWrite: m.cost?.cache_write || 0,
						},
						contextWindow: m.limit?.context || 4096,
						maxTokens: m.limit?.output || 4096,
					});
					recordModelsDevReasoningOptions(provider, modelId, m);
				}
			}
		}

		// Process Kimi For Coding models
		if (data["kimi-for-coding"]?.models) {
			const liveKimiModels = data["kimi-for-coding"].models as Record<string, ModelsDevModel>;
			const kimiModels: Record<string, ModelsDevModel> = {
				...KIMI_CODING_STABLE_MODELS,
				...liveKimiModels,
			};
			const hasCanonicalModel = Object.prototype.hasOwnProperty.call(kimiModels, "kimi-for-coding");

			const kimiAliases = new Set(["k2p5", "k2p6", "k2p7"]);

			for (const [modelId, m] of Object.entries(kimiModels)) {
				if (m.tool_call !== true) continue;
				// models.dev may expose versioned aliases (e.g. k2p5/k2p6/k2p7).
				// Normalize aliases to the canonical model id and drop duplicates when canonical exists.
				if (kimiAliases.has(modelId) && hasCanonicalModel) continue;

				const normalizedId = kimiAliases.has(modelId) ? "kimi-for-coding" : modelId;
				const normalizedName = kimiAliases.has(modelId) ? "Kimi For Coding" : m.name || normalizedId;
				const isKimiK3 = normalizedId === "k3";
				const allowEmptySignature = isKimiK3 || normalizedId === "kimi-for-coding";
				const impliedCost = KIMI_CODING_IMPLIED_COSTS[normalizedId];

				models.push({
					id: normalizedId,
					name: normalizedName,
					api: "anthropic-messages",
					provider: "kimi-coding",
					// Kimi For Coding's Anthropic-compatible API - SDK appends /v1/messages
					baseUrl: "https://api.kimi.com/coding",
					compat: {
						...(allowEmptySignature ? { allowEmptySignature: true } : {}),
						forceAdaptiveThinking: true,
					},
					reasoning: isKimiK3 || m.reasoning === true,
					...(isKimiK3 ? { thinkingLevelMap: KIMI_K3_THINKING_LEVEL_MAP } : {}),
					// K3 accepts video input on the Kimi coding endpoint (kimi-code parity:
					// Anthropic-compatible `{type:"video"}` content blocks).
					input: isKimiK3
						? ["text", "image", "video"]
						: m.modalities?.input?.includes("image")
							? ["text", "image"]
							: ["text"],
					cost: {
						input: m.cost?.input || impliedCost?.input || 0,
						output: m.cost?.output || impliedCost?.output || 0,
						cacheRead: m.cost?.cache_read || impliedCost?.cacheRead || 0,
						cacheWrite: m.cost?.cache_write || impliedCost?.cacheWrite || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions("kimi-coding", normalizedId, m);
			}
		}

		// Process Moonshot AI models
		const moonshotVariants = [
			{ key: "moonshotai", provider: "moonshotai", baseUrl: "https://api.moonshot.ai/v1" },
			{ key: "moonshotai-cn", provider: "moonshotai-cn", baseUrl: "https://api.moonshot.cn/v1" },
		] as const;
		const moonshotCompat: OpenAICompletionsCompat = {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			thinkingFormat: "deepseek",
		};
		const getMoonshotProviderModels = (key: "moonshotai" | "moonshotai-cn"): Record<string, ModelsDevModel> => {
			const providerModels = data[key]?.models as Record<string, ModelsDevModel> | undefined;
			return providerModels ? { ...providerModels } : {};
		};
		const moonshotModels = {
			moonshotai: getMoonshotProviderModels("moonshotai"),
			"moonshotai-cn": getMoonshotProviderModels("moonshotai-cn"),
		};

		for (const { key, provider, baseUrl } of moonshotVariants) {
			for (const [modelId, m] of Object.entries(moonshotModels[key])) {
				if (m.tool_call !== true) continue;

				const isKimiK3 = modelId === "kimi-k3";
				const compat = isKimiK3 ? { ...moonshotCompat } : moonshotCompat;
				if (isKimiK3) {
					compat.requiresReasoningContentOnAssistantMessages = true;
					compat.thinkingFormat = "openai";
					compat.supportsReasoningEffort = true;
				}
				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					reasoning: isKimiK3 || m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || (isKimiK3 ? KIMI_K3_COST.input : 0),
						output: m.cost?.output || (isKimiK3 ? KIMI_K3_COST.output : 0),
						cacheRead: m.cost?.cache_read || (isKimiK3 ? KIMI_K3_COST.cacheRead : 0),
						cacheWrite: m.cost?.cache_write || (isKimiK3 ? KIMI_K3_COST.cacheWrite : 0),
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
					compat,
				});
				recordModelsDevReasoningOptions(provider, modelId, m);
			}
		}

		// Process Xiaomi MiMo models
		// Built-in `xiaomi` targets the API billing endpoint (single stable URL,
		// keys from platform.xiaomimimo.com). The three `xiaomi-token-plan-*`
		// providers cover prepaid Token Plan endpoints in cn / ams / sgp.
		const xiaomiCompat: OpenAICompletionsCompat = {
			requiresReasoningContentOnAssistantMessages: true,
			thinkingFormat: "deepseek",
			supportsDisabledThinking: false,
		};
		const xiaomiVariants = [
			{ source: "xiaomi", provider: "xiaomi", baseUrl: "https://api.xiaomimimo.com/v1" },
			{
				source: "xiaomi-token-plan-cn",
				provider: "xiaomi-token-plan-cn",
				baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
			},
			{
				source: "xiaomi-token-plan-ams",
				provider: "xiaomi-token-plan-ams",
				baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
			},
			{
				source: "xiaomi-token-plan-sgp",
				provider: "xiaomi-token-plan-sgp",
				baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
			},
		] as const;

		for (const { source, provider, baseUrl } of xiaomiVariants) {
			const providerModels = data[source]?.models;
			if (!providerModels) continue;

			for (const [modelId, model] of Object.entries(providerModels)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (m.status === "deprecated") continue;

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					compat: xiaomiCompat,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				recordModelsDevReasoningOptions(provider, modelId, m);
			}
		}

		// Process Alibaba Cloud Model Studio Token Plan models. International and
		// China use separate endpoints and API keys (sk-sp- prefix). The Individual
		// provider reuses the international source and endpoint with a narrower catalog.
		// models.dev keys are "alibaba-token-plan[-cn]"; pi exposes them as
		// "qwen-token-plan[-cn]" plus the Individual catalog view.
		const qwenTokenPlanCompat: OpenAICompletionsCompat = {
			thinkingFormat: "qwen",
			supportsDeveloperRole: false,
			supportsStore: false,
			supportsReasoningEffort: true,
		};
		const qwenTokenPlanVariants = [
			{
				source: "alibaba-token-plan",
				provider: "qwen-token-plan",
				baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
				modelIds: undefined,
			},
			{
				source: "alibaba-token-plan",
				provider: "qwen-token-plan-individual",
				baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
				modelIds: QWEN_TOKEN_PLAN_INDIVIDUAL_MODEL_IDS,
			},
			{
				source: "alibaba-token-plan-cn",
				provider: "qwen-token-plan-cn",
				baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
				modelIds: undefined,
			},
		] as const;

		for (const { source, provider, baseUrl, modelIds } of qwenTokenPlanVariants) {
			const providerModels = data[source]?.models;
			const emittedModelIds = modelIds ? new Set<string>() : undefined;

			for (const [modelId, model] of Object.entries(providerModels ?? {})) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;
				if (QWEN_TOKEN_PLAN_EXCLUDED_MODEL_IDS.has(modelId)) continue;
				if (modelIds && !modelIds.has(modelId)) continue;
				const thinkingLevelMap =
					getEffortThinkingLevelMap(m.reasoning_options ?? []) ??
					(QWEN_TOKEN_PLAN_REASONING_EFFORT_FALLBACK_MODEL_IDS.has(modelId)
						? QWEN_TOKEN_PLAN_FALLBACK_THINKING_LEVEL_MAP
						: undefined);

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider,
					baseUrl,
					compat: thinkingLevelMap
						? qwenTokenPlanCompat
						: { ...qwenTokenPlanCompat, supportsReasoningEffort: false },
					...(thinkingLevelMap ? { thinkingLevelMap } : {}),
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
				emittedModelIds?.add(modelId);
			}

			if (modelIds && emittedModelIds && generatorOptions.strict) {
				assertExactModelIds(provider, modelIds, emittedModelIds);
			}
		}

		// Alibaba Cloud Model Studio Token Plan (prepaid, OpenAI-compatible).
		// The models.dev `alibaba-token-plan` catalog targets the ap-southeast-1
		// endpoint; image/video models are skipped via the tool_call filter.
		const alibabaTokenPlanBaseUrl = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
		const alibabaTokenPlanModels = data["alibaba-token-plan"]?.models;
		if (alibabaTokenPlanModels) {
			for (const [modelId, model] of Object.entries(alibabaTokenPlanModels)) {
				const m = model as ModelsDevModel;
				if (m.tool_call !== true) continue;

				const compat: OpenAICompletionsCompat = {
					supportsStore: false,
					supportsDeveloperRole: false,
					maxTokensField: "max_tokens",
				};
				const family = modelId.toLowerCase();
				if (family.startsWith("qwen")) {
					// DashScope compatible-mode toggles Qwen thinking via top-level enable_thinking.
					compat.thinkingFormat = "qwen";
				} else if (family.startsWith("deepseek")) {
					compat.requiresReasoningContentOnAssistantMessages = true;
					compat.thinkingFormat = "deepseek";
				} else if (family.startsWith("kimi")) {
					compat.thinkingFormat = "deepseek";
					compat.supportsReasoningEffort = false;
				}

				models.push({
					id: modelId,
					name: m.name || modelId,
					api: "openai-completions",
					provider: "alibaba-token-plan",
					baseUrl: alibabaTokenPlanBaseUrl,
					compat,
					reasoning: m.reasoning === true,
					input: m.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
					cost: {
						input: m.cost?.input || 0,
						output: m.cost?.output || 0,
						cacheRead: m.cost?.cache_read || 0,
						cacheWrite: m.cost?.cache_write || 0,
					},
					contextWindow: m.limit?.context || 4096,
					maxTokens: m.limit?.output || 4096,
				});
			}
		}

		console.log(`Loaded ${models.length} tool-capable models from models.dev`);
		return models;
	} catch (error) {
		console.error("Failed to load models.dev data:", error);
		if (generatorOptions.strict) throw error;
		return [];
	}
}

async function loadModelsDevClassifierModels(): Promise<ClassifierModel<"typesafe-system-one">[]> {
	try {
		console.log("Fetching classifier models from models.dev API...");
		const response = await fetch("https://models.dev/models.json?type=decision");
		if (!response.ok) throw new Error(`models.dev classifier API returned ${response.status}`);
		const data = (await response.json()) as Record<string, ModelsDevMetadata>;
		const metadata = data["typesafe/jev-latest"];
		if (!metadata || metadata.type !== "decision") {
			throw new Error("models.dev did not return decision model typesafe/jev-latest");
		}
		return [
			{
				type: "classifier",
				id: "jev-latest",
				name: metadata.name,
				api: "typesafe-system-one",
				provider: "typesafe",
				baseUrl: "https://api.typesafe.ai/v1/",
				input: metadata.modalities?.input?.includes("image") ? ["text", "image"] : ["text"],
				// The canonical models.dev entry has no direct-provider pricing. System One reports token usage,
				// so classify() results carry token counts but price them at zero.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: metadata.limit?.context || 64000,
			},
		];
	} catch (error) {
		console.error("Failed to load models.dev classifier data:", error);
		if (generatorOptions.strict) throw error;
		return [];
	}
}

// Workers AI has no unauthenticated catalog and models.dev does not list its
// System One models yet. Cloudflare publishes pricing only in the dashboard.
// https://developers.cloudflare.com/ai/models/typesafe/jev/
// OpenCode Zen serves Jev through its TypeSafe-compatible System One endpoint.
// Neither its /zen/v1/models listing nor models.dev carries metadata for it.
// https://opencode.ai/docs/zen
const OPENCODE_CLASSIFIER_MODELS: ClassifierModel<"typesafe-system-one">[] = [
	{
		type: "classifier",
		id: "jev-1.13",
		name: "Jev 1.13",
		api: "typesafe-system-one",
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		input: ["text"],
		cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
	},
	{
		type: "classifier",
		id: "jev-1.13-free",
		name: "Jev 1.13 Free",
		api: "typesafe-system-one",
		provider: "opencode",
		baseUrl: "https://opencode.ai/zen/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
	},
];

const CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS: ClassifierModel<"cloudflare-workers-ai-system-one">[] = [
	{
		type: "classifier",
		id: "typesafe/jev",
		name: "Jev",
		api: "cloudflare-workers-ai-system-one",
		provider: "cloudflare-workers-ai",
		baseUrl: CLOUDFLARE_WORKERS_AI_REST_BASE_URL,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32000,
	},
];

// Static OpenAI image models. OpenRouter's image listing stays the only live
// source; these entries are hand-authored because OpenAI's own API exposes no
// public image-model catalog to fetch from.
// Source: platform.openai.com model pages, verified 2026-09-09:
// https://platform.openai.com/docs/models/gpt-image-2.5-sunburst
// https://platform.openai.com/docs/models/gpt-image-2.5-flare
// https://platform.openai.com/docs/models/gpt-image-2
// GPT Image 2/2.5: $5 text input / $8 image input / $30 image output / $1.25
// cache-read per 1M tokens (`imageInput` prices reference and edit inputs).
// Keep the existing gpt-image-1.5 zero-filled pricing unchanged.
// GPT Image 2/2.5 accept text generation and reference images via /images/edits.
const OPENAI_IMAGE_MODELS: ImageModel<"openai-images">[] = [
	{
		type: "image",
		id: "gpt-image-2.5-sunburst",
		name: "GPT Image 2.5 Sunburst",
		api: "openai-images",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		input: ["text", "image"],
		output: ["image"],
		cost: { input: 5, output: 30, cacheRead: 1.25, cacheWrite: 0, imageInput: 8 },
	},
	{
		type: "image",
		id: "gpt-image-2.5-flare",
		name: "GPT Image 2.5 Flare",
		api: "openai-images",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		input: ["text", "image"],
		output: ["image"],
		cost: { input: 5, output: 30, cacheRead: 1.25, cacheWrite: 0, imageInput: 8 },
	},
	{
		type: "image",
		id: "gpt-image-2",
		name: "GPT Image 2",
		api: "openai-images",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		input: ["text", "image"],
		output: ["image"],
		cost: { input: 5, output: 30, cacheRead: 1.25, cacheWrite: 0, imageInput: 8 },
	},
	{
		type: "image",
		id: "gpt-image-1.5",
		name: "GPT Image 1.5",
		api: "openai-images",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		input: ["text"],
		output: ["image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	},
];

async function generateModels() {
	// Fetch models from all upstream catalogs.
	// models.dev: Anthropic, Google, OpenAI, Groq, Cerebras, and others
	// OpenRouter: its tool-capable routed catalog
	// AI Gateway: OpenAI-compatible catalog with tool-capable models
	// Radius: its unauthenticated public catalog; authenticated clients overlay it at runtime
	// OpenGateway: the fork's gateway catalog (generate-models-opengateway.ts)
	const modelsDevModels = await loadModelsDevData();
	const modelsDevClassifierModels = await loadModelsDevClassifierModels();
	const openRouterCatalog = await fetchOpenRouterModels();
	const aiGatewayCatalog = await fetchAiGatewayModels();
	const radiusModels = await fetchRadiusModels();
	const openGatewayModels = await fetchOpenGatewayModels(
		(id, source) => recordModelsDevReasoningOptions("opengateway", id, source),
		{ strict: generatorOptions.strict },
	);

	// Combine chat models (models.dev has priority where sources overlap).
	const allModels = [
		...modelsDevModels,
		...openRouterCatalog.chat,
		...aiGatewayCatalog.chat,
		...radiusModels,
		...openGatewayModels,
	].filter(
		(model) =>
			!(model.provider === "xai" && XAI_BUILTIN_EXCLUDED_MODEL_IDS.has(model.id)) &&
			!((model.provider === "opencode" || model.provider === "opencode-go") && model.id === "gpt-5.3-codex-spark"),
	);
	allModels.push(...getBaiModels());

	// Add Claude Opus 5.5 until models.dev includes it.
	// https://platform.claude.com/docs/en/models/opus-5-5/overview
	if (!allModels.some((model) => model.provider === "anthropic" && model.id === "claude-opus-5-5")) {
		allModels.push({
			id: "claude-opus-5-5",
			name: "Claude Opus 5.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
			contextWindow: 1000000,
			maxTokens: 128000,
		});
	}

	// Add Claude Sonnet 5.5 until models.dev includes it.
	// https://platform.claude.com/docs/en/models/sonnet-5-5/overview
	if (!allModels.some((model) => model.provider === "anthropic" && model.id === "claude-sonnet-5-5")) {
		allModels.push({
			id: "claude-sonnet-5-5",
			name: "Claude Sonnet 5.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
			contextWindow: 1000000,
			maxTokens: 128000,
		});
	}

	// Keep Claude Haiku 5.5 when models.dev omits it. A prompt over 100K input tokens bills the whole
	// request at the long-context rates.
	// https://platform.claude.com/docs/en/models/haiku-5-5/overview
	if (!allModels.some((model) => model.provider === "anthropic" && model.id === "claude-haiku-5-5")) {
		allModels.push({
			id: "claude-haiku-5-5",
			name: "Claude Haiku 5.5",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: {
				input: 0.1,
				output: 0.5,
				cacheRead: 0.01,
				cacheWrite: 0.125,
				tiers: [{ inputTokensAbove: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }],
			},
			contextWindow: 1000000,
			maxTokens: 128000,
		});
	}

	// The authenticated Copilot catalog advertised these models on 2026-09-22,
	// but models.dev did not include them yet.
	const missingCopilotModels: Model<Api>[] = [
		{
			id: "claude-opus-5.5",
			name: "Claude Opus 5.5",
			api: "anthropic-messages",
			provider: "github-copilot",
			baseUrl: "https://api.individual.githubcopilot.com",
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			},
			input: ["text", "image"],
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
			contextWindow: 1000000,
			maxTokens: 128000,
			headers: { ...COPILOT_STATIC_HEADERS },
		},
		...(["gpt-6-sol", "gpt-6-luna"] as const).map((id) => ({
			id,
			name: id === "gpt-6-sol" ? "GPT-6 Sol" : "GPT-6 Luna",
			api: "openai-responses" as const,
			provider: "github-copilot" as const,
			baseUrl: "https://api.individual.githubcopilot.com",
			reasoning: true,
			input: ["text", "image"] as ("text" | "image")[],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS[id]),
			contextWindow: 1000000,
			maxTokens: 128000,
			headers: { ...COPILOT_STATIC_HEADERS },
		})),
	];
	for (const model of missingCopilotModels) {
		if (!allModels.some((candidate) => candidate.provider === model.provider && candidate.id === model.id)) {
			allModels.push(model);
		}
	}

	// Temporary overrides until upstream model metadata is corrected.
	for (const candidate of allModels) {
		if (candidate.provider === "github-copilot" && GITHUB_COPILOT_EXTENDED_CONTEXT_MODELS.has(candidate.id)) {
			candidate.contextWindow = 1000000;
		}

		if (/haiku-5[.-]5/.test(candidate.id)) {
			candidate.cost = withClaudeHaiku55LongContextPricing(candidate.cost);
			// Open at the 100K price band so compaction runs before a prompt crosses into the 5x rates; the
			// full 1M window with the documented 128K output is an explicit models.json `modelOverrides` opt-in
			// (oh-my-pi #14903 caps the window the same way; senpi#2916 tracks a first-class opt-in). Output
			// drops to 32K with it: compaction reserves min(maxTokens, half the window) for output, so 128K would
			// start emergency pruning at under half of a 100K window.
			candidate.contextWindow = Math.min(candidate.contextWindow, CLAUDE_HAIKU_55_LONG_CONTEXT_INPUT_THRESHOLD);
			candidate.maxTokens = Math.min(candidate.maxTokens, CLAUDE_HAIKU_55_BANDED_MAX_TOKENS);
		}

		// models.dev may list Opus 5.5, Sonnet 5.5 and Haiku 5.5 before their effort metadata is complete.
		if (
			(candidate.provider === "anthropic" &&
				(candidate.id === "claude-opus-5-5" ||
					candidate.id === "claude-sonnet-5-5" ||
					candidate.id === "claude-haiku-5-5")) ||
			(candidate.provider === "github-copilot" && candidate.id === "claude-opus-5.5")
		) {
			mergeThinkingLevelMap(candidate, {
				off: null,
				minimal: null,
				low: "low",
				medium: "medium",
				high: "high",
				xhigh: "xhigh",
				max: "max",
			});
		}

		if (
			(candidate.provider === "anthropic" ||
				candidate.provider === "opencode" ||
				candidate.provider === "opencode-go") &&
			(candidate.id === "claude-opus-4-6" ||
				candidate.id === "claude-sonnet-4-6" ||
				candidate.id === "claude-opus-4.6" ||
				candidate.id === "claude-sonnet-4.6" ||
				candidate.id === "claude-opus-4-7" ||
				candidate.id === "claude-opus-4.7")
		) {
			candidate.contextWindow = 1000000;
		}

		// OpenCode variants list Claude Sonnet 4/4.5 with 1M context, actual limit is 200K
		if (
			(candidate.provider === "opencode" || candidate.provider === "opencode-go") &&
			(candidate.id === "claude-sonnet-4-5" || candidate.id === "claude-sonnet-4")
		) {
			candidate.contextWindow = 200000;
		}
		if ((candidate.provider === "opencode" || candidate.provider === "opencode-go") && candidate.id === "gpt-5.4") {
			candidate.contextWindow = 272000;
			candidate.maxTokens = 128000;
		}
		// Keep direct OpenAI requests in the short-context pricing tier by default. Users can opt into the
		// larger context through model overrides, so retain long-context cost metadata on the capped models.
		if (candidate.provider === "openai" && OPENAI_SHORT_CONTEXT_CAPPED_MODEL_IDS.has(candidate.id)) {
			candidate.contextWindow = OPENAI_LONG_CONTEXT_INPUT_THRESHOLD;
			candidate.maxTokens = 128000;
		}
		const flagshipContextWindow = OPENAI_FLAGSHIP_DEFAULT_CONTEXT_WINDOWS.get(candidate.id);
		if (candidate.provider === "openai" && flagshipContextWindow !== undefined) {
			candidate.contextWindow = flagshipContextWindow;
		}
		if (candidate.provider === "openai" && OPENAI_LONG_CONTEXT_PRICING_MODEL_IDS.has(candidate.id)) {
			const standardCost = OPENAI_STANDARD_COSTS[candidate.id];
			candidate.cost = withOpenAiLongContextPricing(standardCost ?? candidate.cost);
		}
		// Cloudflare AI Gateway passes OpenAI usage through at OpenAI list prices.
		if (candidate.provider === "cloudflare-ai-gateway") {
			const standardCost = OPENAI_STANDARD_COSTS[candidate.id];
			if (standardCost) candidate.cost = withOpenAiLongContextPricing(standardCost);
		}
		// Keep Kimi K3's canonical output limit when gateway metadata is missing or incorrect.
		if (
			(candidate.provider === "openrouter" && OPENROUTER_KIMI_K3_MODEL_IDS.has(candidate.id)) ||
			(candidate.provider === "vercel-ai-gateway" && candidate.id === "moonshotai/kimi-k3")
		) {
			candidate.maxTokens = KIMI_K3_MAX_TOKENS;
		}
		// Keep selected OpenRouter model metadata stable until upstream settles.
		if (candidate.provider === "openrouter" && candidate.id === "moonshotai/kimi-k2.5") {
			candidate.cost.input = 0.41;
			candidate.cost.output = 2.06;
			candidate.cost.cacheRead = 0.07;
			candidate.maxTokens = 4096;
		}
		if (candidate.provider === "openrouter" && candidate.id.startsWith("moonshotai/kimi-k2.6")) {
			candidate.compat = {
				...candidate.compat,
				supportsDeveloperRole: false,
				requiresReasoningContentOnAssistantMessages: true,
			};
		}
		if (candidate.provider === "openrouter" && candidate.id === "z-ai/glm-5") {
			candidate.cost.input = 0.6;
			candidate.cost.output = 1.9;
			candidate.cost.cacheRead = 0.119;
		}
	}

	// Add missing EU Opus 4.6 profile
	if (!allModels.some((m) => m.provider === "amazon-bedrock" && m.id === "eu.anthropic.claude-opus-4-6-v1")) {
		allModels.push({
			id: "eu.anthropic.claude-opus-4-6-v1",
			name: "Claude Opus 4.6 (EU)",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			baseUrl: getBedrockBaseUrl("eu.anthropic.claude-opus-4-6-v1"),
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			},
			contextWindow: 200000,
			maxTokens: 128000,
		});
	}

	// Add missing Claude Opus 4.6
	if (!allModels.some(m => m.provider === "anthropic" && m.id === "claude-opus-4-6")) {
		allModels.push({
			id: "claude-opus-4-6",
			name: "Claude Opus 4.6",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			provider: "anthropic",
			reasoning: true,
			thinkingLevelMap: { max: "max" },
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			},
			contextWindow: 1000000,
			maxTokens: 128000,
		});
	}

	// Add missing Claude Opus 4.7 (released April 16, 2026)
	if (!allModels.some(m => m.provider === "anthropic" && m.id === "claude-opus-4-7")) {
		allModels.push({
			id: "claude-opus-4-7",
			name: "Claude Opus 4.7",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			provider: "anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			},
			contextWindow: 1000000,
			maxTokens: 128000,
		});
	}

	// Add missing Bedrock Opus 4.7 cross-region profiles
	const bedrockOpus47Profiles: Array<{ id: string; name: string }> = [
		{ id: "anthropic.claude-opus-4-7", name: "Claude Opus 4.7" },
		{ id: "us.anthropic.claude-opus-4-7", name: "Claude Opus 4.7 (US)" },
		{ id: "eu.anthropic.claude-opus-4-7", name: "Claude Opus 4.7 (EU)" },
		{ id: "global.anthropic.claude-opus-4-7", name: "Claude Opus 4.7 (Global)" },
	];
	for (const profile of bedrockOpus47Profiles) {
		if (!allModels.some((m) => m.provider === "amazon-bedrock" && m.id === profile.id)) {
			allModels.push({
				id: profile.id,
				name: profile.name,
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
				reasoning: true,
				input: ["text", "image"],
				cost: {
					input: 5,
					output: 25,
					cacheRead: 0.5,
					cacheWrite: 6.25,
				},
				contextWindow: 1000000,
				maxTokens: 128000,
			});
		}
	}

	// Add missing Claude Opus 4.8
	if (!allModels.some(m => m.provider === "anthropic" && m.id === "claude-opus-4-8")) {
		allModels.push({
			id: "claude-opus-4-8",
			name: "Claude Opus 4.8",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			provider: "anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 5,
				output: 25,
				cacheRead: 0.5,
				cacheWrite: 6.25,
			},
			contextWindow: 1000000,
			maxTokens: 128000,
		});
	}

	// Add missing Claude Sonnet 4.6
	if (!allModels.some(m => m.provider === "anthropic" && m.id === "claude-sonnet-4-6")) {
		allModels.push({
			id: "claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com",
			provider: "anthropic",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 3,
				output: 15,
				cacheRead: 0.3,
				cacheWrite: 3.75,
			},
			contextWindow: 1000000,
			maxTokens: 64000,
		});
	}

	if (!allModels.some((m) => m.provider === "cloudflare-ai-gateway" && m.id === "claude-sonnet-5")) {
		allModels.push({
			id: "claude-sonnet-5",
			name: "Claude Sonnet 5",
			api: "anthropic-messages",
			baseUrl: CLOUDFLARE_AI_GATEWAY_ANTHROPIC_BASE_URL,
			provider: "cloudflare-ai-gateway",
			compat: { sendSessionAffinityHeaders: true },
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 2,
				output: 10,
				cacheRead: 0.2,
				cacheWrite: 2.5,
			},
			contextWindow: 1000000,
			maxTokens: 128000,
		});
	}

	// Add missing Gemini 3.1 Flash Lite Preview until models.dev includes it.
	if (!allModels.some((m) => m.provider === "google" && m.id === "gemini-3.1-flash-lite-preview")) {
		allModels.push({
			id: "gemini-3.1-flash-lite-preview",
			name: "Gemini 3.1 Flash Lite Preview",
			api: "google-generative-ai",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			provider: "google",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1048576,
			maxTokens: 65536,
		});
	}

	// Add missing gpt models
	const missingOpenAiModels: Model<"openai-responses">[] = [
		{
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }),
			contextWindow: GPT_6_ASTRA_DEFAULT_CONTEXT_WINDOW,
			maxTokens: 128000,
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
		},
		{
			id: "gpt-6.1-sol",
			name: "GPT-6.1 Sol",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_GPT_6_STANDARD_COSTS["gpt-6.1-sol"]),
			contextWindow: GPT_6_SOL_DEFAULT_CONTEXT_WINDOW,
			maxTokens: 128000,
		},
		{
			id: "gpt-6-sol",
			name: "GPT-6 Sol",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_GPT_6_STANDARD_COSTS["gpt-6-sol"]),
			contextWindow: GPT_6_SOL_DEFAULT_CONTEXT_WINDOW,
			maxTokens: 128000,
		},
		{
			id: "gpt-6-luna",
			name: "GPT-6 Luna",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_GPT_6_STANDARD_COSTS["gpt-6-luna"]),
			contextWindow: GPT_6_LUNA_DEFAULT_CONTEXT_WINDOW,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-sol"]),
			contextWindow: GPT_56_SOL_DEFAULT_CONTEXT_WINDOW,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-terra"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-luna"]),
			contextWindow: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
			maxTokens: 128000,
		},
		{
			id: "gpt-5-chat-latest",
			name: "GPT-5 Chat Latest",
			api: "openai-responses",
			baseUrl: "https://api.openai.com/v1",
			provider: "openai",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 1.25,
				output: 10,
				cacheRead: 0.125,
				cacheWrite: 0,
			},
			contextWindow: 128000,
			maxTokens: 16384,
		},
	];
	for (const model of missingOpenAiModels) {
		if (!allModels.some((m) => m.provider === model.provider && m.id === model.id)) {
			allModels.push(model);
		}
	}

	const deepseekCompat: OpenAICompletionsCompat = {
		requiresReasoningContentOnAssistantMessages: true,
		thinkingFormat: "deepseek",
	};
	const deepseekModels: Model<"openai-completions">[] = [
		{
			id: "deepseek-flash",
			name: "DeepSeek V4.1 Flash",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			thinkingLevelMap: DEEPSEEK_V4_FLASH_THINKING_LEVEL_MAP,
			input: ["text", "image"],
			cost: {
				// DeepSeek also offers time-based off-peak rates, which the cost schema cannot represent yet.
				input: 0.3,
				output: 1.2,
				cacheRead: 0.006,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: deepseekCompat,
		},
		{
			id: "deepseek-v4-pro",
			name: "DeepSeek V4 Pro",
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			provider: "deepseek",
			reasoning: true,
			input: ["text"],
			cost: {
				// DeepSeek also offers time-based off-peak rates, which the cost schema cannot represent yet.
				input: 1.32,
				output: 3.96,
				cacheRead: 0.044,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 384000,
			compat: deepseekCompat,
		},
	];
	allModels.push(...deepseekModels);

	const antLingCompat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
		supportsLongCacheRetention: false,
	};
	const antLingModels: Model<"openai-completions">[] = [
		{
			id: "Ling-2.6-flash",
			name: "Ling 2.6 Flash",
			api: "openai-completions",
			baseUrl: "https://api.ant-ling.com/v1",
			provider: "ant-ling",
			reasoning: false,
			input: ["text"],
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
			compat: antLingCompat,
		},
		{
			id: "Ling-2.6-1T",
			name: "Ling 2.6 1T",
			api: "openai-completions",
			baseUrl: "https://api.ant-ling.com/v1",
			provider: "ant-ling",
			reasoning: false,
			input: ["text"],
			cost: { input: 0.06, output: 0.25, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
			compat: antLingCompat,
		},
		{
			id: "Ring-2.6-1T",
			name: "Ring 2.6 1T",
			api: "openai-completions",
			baseUrl: "https://api.ant-ling.com/v1",
			provider: "ant-ling",
			reasoning: true,
			input: ["text"],
			cost: { input: 0.06, output: 0.25, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262144,
			maxTokens: 65536,
			compat: { ...antLingCompat, thinkingFormat: "ant-ling" },
		},
	];
	allModels.push(...antLingModels);

	for (const candidate of allModels) {
		if (
			candidate.api === "openai-completions" &&
			candidate.id.includes("deepseek-v4") &&
			!QWEN_TOKEN_PLAN_PROVIDER_IDS.has(candidate.provider)
		) {
			const preservesNativeReasoningEffort = candidate.provider === "openrouter" || candidate.provider === "opencode";
			candidate.compat = {
				...candidate.compat,
				...(preservesNativeReasoningEffort
					? {
							requiresReasoningContentOnAssistantMessages:
								deepseekCompat.requiresReasoningContentOnAssistantMessages,
						}
					: deepseekCompat),
			};
		}
	}

	const minimaxDirectSupportedIds = new Set(["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M3"]);

	for (let i = allModels.length - 1; i >= 0; i--) {
		const candidate = allModels[i];
		if (
			(candidate.provider === "minimax" || candidate.provider === "minimax-cn") &&
			!minimaxDirectSupportedIds.has(candidate.id)
		) {
			allModels.splice(i, 1);
		}
	}

	// OpenAI Codex (ChatGPT OAuth) models
	// NOTE: These are not fetched from models.dev; we keep a small, explicit list to avoid aliases.
	// Older model limits are based on observed server behavior. GPT-5.6 Luna and Terra follow Codex's 272k
	// catalog limit (formerly 372k); Sol defaults to 400k. GPT-6 Astra is stamped with the fork's series
	// default by applyGpt6AstraContextWindow in the final metadata pass.
	const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
	const CODEX_CONTEXT = 272000;
	const CODEX_GPT_56_CONTEXT = 272000;
	const CODEX_SPARK_CONTEXT = 128000;
	const CODEX_MAX_TOKENS = 128000;
	const codexModels: Model<"openai-codex-responses">[] = [
		{
			id: "gpt-5.3-codex-spark",
			name: "GPT-5.3 Codex Spark",
			api: "openai-codex-responses",
			provider: "chatgpt-subscription",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text"],
			cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
			contextWindow: CODEX_SPARK_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.5",
			name: "GPT-5.5",
			api: "openai-codex-responses",
			provider: "chatgpt-subscription",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }),
			contextWindow: CODEX_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-6-astra",
			name: "GPT-6 Astra",
			api: "openai-codex-responses",
			provider: "chatgpt-subscription",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }),
			contextWindow: GPT_6_ASTRA_DEFAULT_CONTEXT_WINDOW,
			maxTokens: CODEX_MAX_TOKENS,
			thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
		},
		{
			id: "gpt-6.1-sol",
			name: "GPT-6.1 Sol",
			api: "openai-codex-responses",
			provider: "chatgpt-subscription",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_GPT_6_STANDARD_COSTS["gpt-6.1-sol"]),
			contextWindow: GPT_6_SOL_DEFAULT_CONTEXT_WINDOW,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-6-sol",
			name: "GPT-6 Sol",
			api: "openai-codex-responses",
			provider: "chatgpt-subscription",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_GPT_6_STANDARD_COSTS["gpt-6-sol"]),
			contextWindow: GPT_6_SOL_DEFAULT_CONTEXT_WINDOW,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-6-luna",
			name: "GPT-6 Luna",
			api: "openai-codex-responses",
			provider: "chatgpt-subscription",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_GPT_6_STANDARD_COSTS["gpt-6-luna"]),
			contextWindow: GPT_6_LUNA_DEFAULT_CONTEXT_WINDOW,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-luna",
			name: "GPT-5.6 Luna",
			api: "openai-codex-responses",
			provider: "chatgpt-subscription",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-luna"]),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-sol",
			name: "GPT-5.6 Sol",
			api: "openai-codex-responses",
			provider: "chatgpt-subscription",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-sol"]),
			contextWindow: GPT_56_SOL_DEFAULT_CONTEXT_WINDOW,
			maxTokens: CODEX_MAX_TOKENS,
		},
		{
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			api: "openai-codex-responses",
			provider: "chatgpt-subscription",
			baseUrl: CODEX_BASE_URL,
			reasoning: true,
			input: ["text", "image"],
			cost: withOpenAiLongContextPricing(OPENAI_STANDARD_COSTS["gpt-5.6-terra"]),
			contextWindow: CODEX_GPT_56_CONTEXT,
			maxTokens: CODEX_MAX_TOKENS,
		},
	];
	allModels.push(...codexModels);

	// Add missing Mistral Medium 3.5 model until models.dev includes it
	if (!allModels.some(m => m.provider === "mistral" && m.id === "mistral-medium-3.5")) {
		allModels.push({
			id: "mistral-medium-3.5",
			name: "Mistral Medium 3.5",
			api: "mistral-conversations",
			provider: "mistral",
			baseUrl: "https://api.mistral.ai",
			reasoning: true,
			thinkingLevelMap: getEffortThinkingLevelMap([{ type: "effort", values: ["none", "high"] }]),
			input: ["text", "image"],
			cost: {
				input: 1.5,
				output: 7.5,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 262144, // 256k tokens
			maxTokens: 262144,
		});
	}

	// Add "auto" alias for openrouter/auto
	if (!allModels.some(m => m.provider === "openrouter" && m.id === "auto")) {
		allModels.push({
			id: "auto",
			name: "Auto",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: {
				// we dont know about the costs because OpenRouter auto routes to different models
				// and then charges you for the underlying used model
				input:0,
				output:0,
				cacheRead:0,
				cacheWrite:0,
			},
			contextWindow: 2000000,
			maxTokens: 30000,
		});
	}

	// Add "fusion" alias for openrouter/fusion. OpenRouter exposes Fusion as a
	// router alias/plugin entry point; its model metadata does not advertise
	// tools, but the alias resolves to a concrete model that can invoke caller
	// tools and has the openrouter:fusion server tool auto-injected.
	if (!allModels.some(m => m.provider === "openrouter" && m.id === "openrouter/fusion")) {
		allModels.push({
			id: "openrouter/fusion",
			name: "OpenRouter: Fusion",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			input: ["text"],
			cost: {
				// we dont know about the costs because Fusion routes to multiple models
				// and then charges you for the underlying used models
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
			},
			contextWindow: 1000000,
			maxTokens: 30000,
		});
	}

	// Azure Foundry deploys these with larger context windows than OpenAI's own short-tier defaults.
	// See models-sold-directly-by-azure docs.
	const AZURE_CONTEXT_WINDOW_OVERRIDES: Record<string, number> = {
		"gpt-5.4": OPENAI_MAX_CONTEXT_INPUT_CAP,
		"gpt-5.5": OPENAI_MAX_CONTEXT_INPUT_CAP,
		"gpt-5.6-luna": OPENAI_MAX_CONTEXT_INPUT_CAP,
		"gpt-5.6-sol": OPENAI_MAX_CONTEXT_INPUT_CAP,
		"gpt-5.6-terra": OPENAI_MAX_CONTEXT_INPUT_CAP,
	};
	const azureOpenAiModels: Model<Api>[] = allModels
		.filter((model) => model.provider === "openai" && model.api === "openai-responses")
		.map((model) => ({
			...model,
			api: "azure-openai-responses",
			provider: "azure-openai-responses",
			baseUrl: "",
			cost: {
				input: model.cost.input,
				output: model.cost.output,
				cacheRead: model.cost.cacheRead,
				cacheWrite: model.cost.cacheWrite,
			},
			contextWindow: AZURE_CONTEXT_WINDOW_OVERRIDES[model.id] ?? model.contextWindow,
		}));
	allModels.push(...azureOpenAiModels);

	for (const model of allModels) {
		applyOpenAiInputCap(model);
		applyOpenAICompletionsCompatMetadata(model);
		applyAnthropicMessagesCompatMetadata(model);
		applyModelsDevReasoningOptionMetadata(model);
		applyThinkingLevelMetadata(model);
		applyToggleOnlyThinkingLevelMap(model);
		applyStrictToolCompatMetadata(model);
		applyOpenAIGrammarToolCompatMetadata(model);
		applyOpenAIToolSearchMetadata(model);
		applyOpenAICompletionsTranscriptMetadata(model);
		applyOpenAIResponsesTranscriptMetadata(model);
		applyOpenAIExplicitPromptCacheMetadata(model);
		applyOpenAIConfigurationUpdateMetadata(model);
		applyGpt6ContextWindow(model);
		applyGpt6ThinkingLevels(model);
		applyBaiReasoningConsistency(model);
		applyPromptCacheMetadata(model);
		applyImageInputMetadata(model);
	}
	applyAnthropicAllowedFallbackModelMetadata(allModels.filter(isAnthropicFallbackMetadataModel));

	// Emit after metadata application so variants clone fully processed base models.
	// Cost rates stay at base values: the openai-responses and openai-codex-responses
	// adapters multiply usage cost by the service-tier multiplier at request time, so
	// raised catalog rates would double-count. Scoped to the direct OpenAI provider and
	// the Codex backend (both support Priority service tier via service_tier=priority).
	// Azure clones are intentionally excluded (they proxy OpenAI and would double-count).
	const openAiFastVariants: Model<Api>[] = [];
	for (const model of allModels) {
		if (model.provider !== "openai" || !OPENAI_PRIORITY_TIER_MODEL_IDS.has(model.id)) continue;
		openAiFastVariants.push({
			...model,
			id: `${model.id}-fast`,
			name: `${model.name} Fast`,
			upstreamModelId: model.id,
			serviceTier: "priority",
		});
	}
	const codexFastVariants: Model<Api>[] = [];
	for (const model of allModels) {
		if (model.provider !== "chatgpt-subscription" || !CHATGPT_SUBSCRIPTION_PRIORITY_TIER_MODEL_IDS.has(model.id)) continue;
		codexFastVariants.push({
			...model,
			id: `${model.id}-fast`,
			name: `${model.name} Fast`,
			upstreamModelId: model.id,
			serviceTier: "priority",
		});
	}
	allModels.push(...openAiFastVariants, ...codexFastVariants);

	// Subscription-only alias: keep Standard rates; adapters apply Ultrafast pricing at request time.
	// Clone after metadata application, just like the Priority variants above.
	const codexUltrafastVariants: Model<Api>[] = [];
	for (const model of allModels) {
		if (model.provider !== "chatgpt-subscription" || model.id !== "gpt-6.1-sol") continue;
		codexUltrafastVariants.push({
			...model,
			id: `${model.id}-ultrafast`,
			name: `${model.name} Ultrafast`,
			upstreamModelId: model.id,
			serviceTier: "ultrafast",
			defaultThinkingLevel: "xhigh",
		});
	}
	allModels.push(...codexUltrafastVariants);

	// Keep chat and image catalogs separate so one upstream ID can expose both
	// operations with different API implementations.
	type ProviderCatalog = {
		chat: Record<string, Model<Api>>;
		image: Record<string, ImageModel<ImageApi>>;
		classifier: Record<string, ClassifierModel<ClassifierApi>>;
	};
	const providers: Record<string, ProviderCatalog> = {};
	for (const model of allModels) {
		providers[model.provider] ??= { chat: {}, image: {}, classifier: {} };
		// Only add if not already present (models.dev takes priority over OpenRouter).
		providers[model.provider].chat[model.id] ??= { ...model, type: "chat" };
	}
	for (const model of openRouterCatalog.images) {
		applyImageInputMetadata(model);
		providers[model.provider] ??= { chat: {}, image: {}, classifier: {} };
		providers[model.provider].image[model.id] ??= model;
	}
	for (const model of OPENAI_IMAGE_MODELS) {
		const imageModel = structuredClone(model);
		applyImageInputMetadata(imageModel);
		providers[imageModel.provider] ??= { chat: {}, image: {}, classifier: {} };
		providers[imageModel.provider].image[imageModel.id] ??= imageModel;
	}
	const classifierModels: ClassifierModel<ClassifierApi>[] = [
		...modelsDevClassifierModels,
		...openRouterCatalog.classifiers,
		...aiGatewayCatalog.classifiers,
		...OPENCODE_CLASSIFIER_MODELS,
		...CLOUDFLARE_WORKERS_AI_CLASSIFIER_MODELS,
	];
	for (const model of classifierModels) {
		providers[model.provider] ??= { chat: {}, image: {}, classifier: {} };
		providers[model.provider].classifier[model.id] ??= model;
	}

	const sortedProviderIds = Object.keys(providers).sort();
	const jsonChatProviders: Record<string, Record<string, Model<Api>>> = {};
	const jsonImageProviders: Record<string, Record<string, ImageModel<ImageApi>>> = {};
	const jsonClassifierProviders: Record<string, Record<string, ClassifierModel<ClassifierApi>>> = {};
	const jsonAllProviders: Record<string, AnyModel[]> = {};
	for (const providerId of sortedProviderIds) {
		jsonChatProviders[providerId] = Object.fromEntries(
			Object.entries(providers[providerId].chat).sort(([left], [right]) => left.localeCompare(right)),
		);
		jsonImageProviders[providerId] = Object.fromEntries(
			Object.entries(providers[providerId].image).sort(([left], [right]) => left.localeCompare(right)),
		);
		jsonClassifierProviders[providerId] = Object.fromEntries(
			Object.entries(providers[providerId].classifier).sort(([left], [right]) => left.localeCompare(right)),
		);
		jsonAllProviders[providerId] = [
			...Object.values(jsonChatProviders[providerId]),
			...Object.values(jsonImageProviders[providerId]),
			...Object.values(jsonClassifierProviders[providerId]),
		];
	}

	const serializeJson = (value: unknown) => `${JSON.stringify(value, null, generatorOptions.pretty ? 2 : undefined)}\n`;
	const writeJson = (path: string, value: unknown) => writeFileSync(path, serializeJson(value));
	const existingModelDataStructure = generatorOptions.providerIds ? readModelDataStructure(packageRoot) : undefined;
	const unknownProviderIds =
		generatorOptions.providerIds?.filter(
			(providerId) => existingModelDataStructure === undefined || !Object.hasOwn(existingModelDataStructure, providerId),
		) ?? [];
	if (unknownProviderIds.length > 0) {
		throw new Error(`Unknown provider selector: ${unknownProviderIds.join(", ")}`);
	}
	const generatedDataProviderIds = generatorOptions.providerIds ?? (generatorOptions.dataOnly ? readModelDataProviderIds(packageRoot) : sortedProviderIds);
	const missingProviderIds = generatedDataProviderIds.filter((providerId) => !jsonAllProviders[providerId]);
	if (missingProviderIds.length > 0) {
		throw new Error(`Cannot hydrate missing providers: ${missingProviderIds.join(", ")}`);
	}

	// Only the ignored internal data is grouped by API for type derivation.
	const generatedDataProviders: Record<string, Record<string, Record<string, AnyModel>>> = {};
	const modelDataStructure: ModelDataStructure = { ...existingModelDataStructure };
	for (const providerId of generatedDataProviderIds) {
		const models = jsonAllProviders[providerId];
		generatedDataProviders[providerId] = {};
		modelDataStructure[providerId] = {};
		const apiIds = Array.from(new Set(models.map((model) => model.api))).sort();
		for (const api of apiIds) {
			generatedDataProviders[providerId][api] = {};
			for (const model of models) {
				if (model.api !== api) continue;
				const identity = `${model.type}:${model.id}`;
				if (generatedDataProviders[providerId][api][identity]) {
					throw new Error(`${providerId}/${identity} has duplicate ${api} catalog entries`);
				}
				generatedDataProviders[providerId][api][identity] = model;
				modelDataStructure[providerId][identity] = api;
			}
		}
	}

	const generatedAt = generatorOptions.generatedAt ?? new Date().toISOString();

	if (!generatorOptions.jsonOnly) {
		// Stage and validate all provider values before replacing the current generated data.
		const providersDir = join(packageRoot, "src/providers");
		const dataDir = join(providersDir, "data");
		const stagingRoot = mkdtempSync(join(providersDir, ".model-generation-"));
		const stagedDataDir = join(stagingRoot, "data");
		const previousDataDir = join(stagingRoot, "previous-data");
		let restoreGeneratedCatalog: (() => void) | undefined;
		try {
			mkdirSync(stagedDataDir, { recursive: true });
			const fileContents: Record<string, string> = {};
			const stagedProviderIds = existingModelDataStructure ? Object.keys(existingModelDataStructure).sort() : generatedDataProviderIds;
			for (const providerId of stagedProviderIds) {
				const filename = `${providerId}.json`;
				const content = generatedDataProviders[providerId]
					? serializeJson(generatedDataProviders[providerId])
					: readFileSync(join(dataDir, filename), "utf8");
				fileContents[filename] = content;
				writeFileSync(join(stagedDataDir, filename), content);
			}
			writeJson(
				join(stagedDataDir, MODEL_DATA_MANIFEST_FILE),
				createModelDataManifest(modelDataStructure, fileContents, generatedAt),
			);
			validateModelDataDirectory(modelDataStructure, stagedDataDir);

			if (!generatorOptions.dataOnly && !generatorOptions.providerIds) {
				const previousShardContents = new Map(
					readdirSync(providersDir)
						.filter((entry) => entry.endsWith(".models.ts"))
						.map((entry) => [entry, readFileSync(join(providersDir, entry), "utf8")] as const),
				);
				const aggregatorPath = join(packageRoot, "src/models.generated.ts");
				const previousAggregator = readFileSync(aggregatorPath, "utf8");
				restoreGeneratedCatalog = () => {
					for (const entry of readdirSync(providersDir)) {
						if (entry.endsWith(".models.ts")) rmSync(join(providersDir, entry));
					}
					for (const [entry, content] of previousShardContents) {
						writeFileSync(join(providersDir, entry), content);
					}
					writeFileSync(aggregatorPath, previousAggregator);
				};

				const generatedHeader = `// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually - run 'npm run generate-models' to update

`;
				const catalogConstName = (providerId: string) =>
					`${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MODELS`;
				const imageCatalogConstName = (providerId: string) =>
					`${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_IMAGE_MODELS`;
				const classifierCatalogConstName = (providerId: string) =>
					`${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_CLASSIFIER_MODELS`;
				const generatedShardFiles = new Set<string>();
				for (const providerId of sortedProviderIds) {
					let output = generatedHeader;
					output += `import values from "./data/${providerId}.json" with { type: "json" };\n`;
					output += `import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";\n\n`;
					output += `export const ${catalogConstName(providerId)}: ChatModelCatalog<typeof values, ${JSON.stringify(providerId)}> =\n`;
					output += `\tflattenChatModelCatalog(${JSON.stringify(providerId)}, values);\n\n`;
					output += `export const ${imageCatalogConstName(providerId)}: ImageModelCatalog<typeof values, ${JSON.stringify(providerId)}> =\n`;
					output += `\tflattenImageModelCatalog(${JSON.stringify(providerId)}, values);\n\n`;
					output += `export const ${classifierCatalogConstName(providerId)}: ClassifierModelCatalog<typeof values, ${JSON.stringify(providerId)}> =\n`;
					output += `\tflattenClassifierModelCatalog(${JSON.stringify(providerId)}, values);\n`;
					const filename = `${providerId}.models.ts`;
					generatedShardFiles.add(filename);
					writeFileSync(join(providersDir, filename), output);
				}
				const importedShards = importedModelShards(
					readdirSync(providersDir)
						.filter((entry) => entry.endsWith(".ts") && !entry.endsWith(MODEL_SHARD_SUFFIX))
						.map((entry) => readFileSync(join(providersDir, entry), "utf8")),
				);
				for (const entry of readdirSync(providersDir)) {
					if (isPrunableModelShard(entry, generatedShardFiles, importedShards)) rmSync(join(providersDir, entry));
				}

				let output = generatedHeader;
				for (const providerId of sortedProviderIds) {
					output += `import { ${classifierCatalogConstName(providerId)}, ${imageCatalogConstName(providerId)}, ${catalogConstName(providerId)} } from "./providers/${providerId}.models.ts";\n`;
				}
				output += `\nexport const MODELS: {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\treadonly ${JSON.stringify(providerId)}: typeof ${catalogConstName(providerId)};\n`;
				}
				output += `} = {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\t${JSON.stringify(providerId)}: ${catalogConstName(providerId)},\n`;
				}
				output += `};\n\nexport const IMAGE_MODELS: {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\treadonly ${JSON.stringify(providerId)}: typeof ${imageCatalogConstName(providerId)};\n`;
				}
				output += `} = {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\t${JSON.stringify(providerId)}: ${imageCatalogConstName(providerId)},\n`;
				}
				output += `};\n\nexport const CLASSIFIER_MODELS: {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\treadonly ${JSON.stringify(providerId)}: typeof ${classifierCatalogConstName(providerId)};\n`;
				}
				output += `} = {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\t${JSON.stringify(providerId)}: ${classifierCatalogConstName(providerId)},\n`;
				}
				output += `};\n`;
				writeFileSync(aggregatorPath, output);
				console.log("Generated provider catalogs and src/models.generated.ts");
			}

			const hadPreviousData = existsSync(dataDir);
			if (hadPreviousData) renameSync(dataDir, previousDataDir);
			try {
				renameSync(stagedDataDir, dataDir);
				validateGeneratedModelData(packageRoot);
			} catch (error) {
				rmSync(dataDir, { recursive: true, force: true });
				if (hadPreviousData && existsSync(previousDataDir)) renameSync(previousDataDir, dataDir);
				throw error;
			}
			restoreGeneratedCatalog = undefined;
			console.log(
				generatorOptions.dataOnly
					? "Hydrated JSON model values under src/providers/data/"
					: "Generated JSON model values under src/providers/data/",
			);
		} catch (error) {
			restoreGeneratedCatalog?.();
			throw error;
		} finally {
			rmSync(stagingRoot, { recursive: true, force: true });
		}
	}

	if (generatorOptions.jsonOutputDir) {
		// `models.json` and `providers/{id}.json` retain the legacy keyed chat catalog.
		// The `.all` variants are arrays so the same upstream id can appear once per type.
		const providerOutputDir = join(generatorOptions.jsonOutputDir, "providers");
		rmSync(generatorOptions.jsonOutputDir, { recursive: true, force: true });
		mkdirSync(providerOutputDir, { recursive: true });
		writeJson(join(generatorOptions.jsonOutputDir, "models.json"), jsonChatProviders);
		writeJson(join(generatorOptions.jsonOutputDir, "models.all.json"), jsonAllProviders);
		writeJson(join(generatorOptions.jsonOutputDir, "providers.json"), sortedProviderIds);
		for (const providerId of sortedProviderIds) {
			writeJson(join(providerOutputDir, `${providerId}.json`), jsonChatProviders[providerId]);
			writeJson(join(providerOutputDir, `${providerId}.all.json`), jsonAllProviders[providerId]);
		}
		console.log(`Generated JSON model catalog under ${generatorOptions.jsonOutputDir}`);
	}

	// Print statistics
	const totalModels = allModels.length;
	const reasoningModels = allModels.filter((model) => model.reasoning).length;

	console.log(`\nModel Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(providers)) {
		console.log(
			`  ${provider}: ${Object.keys(models.chat).length} chat models, ${Object.keys(models.image).length} image models, ${Object.keys(models.classifier).length} classifier models`,
		);
	}
}

// Run the generator
generateModels().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
