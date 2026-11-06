/**
 * Field classification for the provider surface (custody design 5, row CK5).
 *
 * Every field a user can author in models.json, auth.json and the credential pool has exactly one
 * class: "public" travels as plain config inside the encrypted account config; "sealed" is a secret
 * value sealed per field and opened only for the request that uses it; "device-only" never leaves
 * the owner device; "endpoint" is a URL split by `splitEndpoint`. A field with no entry here has no
 * class, and the classification tests fail on it, so a new field cannot reach the brain unreviewed.
 */

/** "forces-device": a value present moves the whole provider to device custody (no sealed field kind exists for it). */
export type FieldClass = "public" | "sealed" | "device-only" | "endpoint" | "forces-device";
export type Custody = "sealed" | "device";
export type ProviderCapability = "cloud" | "local-only" | "ambient-credential" | "callback-stream";

const COST = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"tiers[].inputTokensAbove",
	"tiers[].input",
	"tiers[].output",
	"tiers[].cacheRead",
	"tiers[].cacheWrite",
] as const;
const PERCENTILES = ["", ".p50", ".p75", ".p90", ".p99"] as const;
const COMPAT = [
	"supportsWebSearch",
	"supportsStore",
	"supportsDeveloperRole",
	"supportsReasoningEffort",
	"supportsUsageInStreaming",
	"supportsFinishReason",
	"maxTokensField",
	"requiresToolResultName",
	"requiresAssistantAfterToolResult",
	"requiresThinkingAsText",
	"requiresReasoningContentOnAssistantMessages",
	"supportsDisabledThinking",
	"thinkingFormat",
	"chatTemplateKwargs.{key}",
	"chatTemplateKwargs.*",
	"chatTemplateKwargs.*.$var",
	"chatTemplateKwargs.*.omitWhenOff",
	"cacheControlFormat",
	...[
		"allow_fallbacks",
		"require_parameters",
		"data_collection",
		"zdr",
		"enforce_distillable_text",
		"order[]",
		"only[]",
		"ignore[]",
		"quantizations[]",
		"sort",
		"sort.by",
		"sort.partition",
		...["prompt", "completion", "image", "audio", "request"].map((part) => `max_price.${part}`),
		...PERCENTILES.map((suffix) => `preferred_min_throughput${suffix}`),
		...PERCENTILES.map((suffix) => `preferred_max_latency${suffix}`),
	].map((field) => `openRouterRouting.${field}`),
	"vercelGatewayRouting.only[]",
	"vercelGatewayRouting.order[]",
	"zaiToolStream",
	"supportsStrictMode",
	"toolCallFormat",
	"sendSessionAffinityHeaders",
	"deferredToolsMode",
	"sessionAffinityFormat",
	"supportsLongCacheRetention",
	"supportsForcedToolChoice",
	"webSearchToolType",
	"supportsWebSocket",
	"supportsRemoteCompactionV2",
	"supportsWebSearchPreview",
	"supportsToolSearch",
	"supportsEagerToolInputStreaming",
	"supportsCacheControlOnTools",
	"supportsTemperature",
	"supportsToolChoice",
	"forceAdaptiveThinking",
	"allowEmptySignature",
	"supportsToolReferences",
	"allowedFallbackModels[].provider",
	"allowedFallbackModels[].model",
	...COST.map((field) => `allowedFallbackModels[].cost.${field}`),
];
const THINKING_LEVEL_MAP = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(
	(level) => `thinkingLevelMap.${level}`,
);
const INPUT_LIMITS = [
	"maxRequestBytes",
	"images.resize.maxWidth",
	"images.resize.maxHeight",
	"images.resize.maxBytes",
	"images.resize.jpegQuality",
	"images.maxPerMessage",
	"images.maxPerRequest",
].map((field) => `inputLimits.${field}`);

const MODEL_DEFINITION: Readonly<Record<string, FieldClass>> = {
	...fields("public", [
		"id",
		"name",
		"upstreamModelId",
		"serviceTier",
		"promptPreset",
		"recoverTextToolCalls",
		"api",
		"reasoning",
		...THINKING_LEVEL_MAP,
		"defaultThinkingLevel",
		"input[]",
		...INPUT_LIMITS,
		...COST.map((field) => `cost.${field}`),
		"promptCache.short",
		"promptCache.long",
		"contextWindow",
		"maxTokens",
		"cacheRetention",
		...COMPAT.map((field) => `compat.${field}`),
		"headers.{key}",
		"extraBody.{key}",
	]),
	baseUrl: "endpoint",
	"headers.*": "sealed",
	"extraBody.*": "forces-device",
};

const MODEL_OVERRIDE: Readonly<Record<string, FieldClass>> = {
	...fields("public", [
		"name",
		"promptPreset",
		"recoverTextToolCalls",
		"reasoning",
		...THINKING_LEVEL_MAP,
		"thinkingLevelMapMode",
		"input[]",
		...INPUT_LIMITS,
		...COMPAT.map((field) => `compat.${field}`),
		...COST.map((field) => `cost.${field}`),
		"promptCache.short",
		"promptCache.long",
		"contextWindow",
		"maxTokens",
		"cacheRetention",
		"headers.{key}",
		"extraBody.{key}",
	]),
	"headers.*": "sealed",
	"extraBody.*": "forces-device",
};

const PROVIDER: Readonly<Record<string, FieldClass>> = {
	...fields("public", [
		"name",
		"disabled",
		"api",
		"headers.{key}",
		"extraBody.{key}",
		"cacheRetention",
		"authHeader",
		"whitelist[]",
		"blacklist[]",
		"hideFreeModels",
		...COMPAT.map((field) => `compat.${field}`),
		"credentials.rotation",
		"credentials.affinity",
		"credentials.accountStrategy",
		"credentials.cooldownBaseMs",
		"credentials.cooldownCapMs",
		"credentials.slots.{key}",
		"modelOverrides.{key}",
	]),
	baseUrl: "endpoint",
	apiKey: "sealed",
	"headers.*": "sealed",
	"extraBody.*": "forces-device",
	"credentials.slots.*.value": "sealed",
	"credentials.slots.*.env": "device-only",
	...prefixed("models[].", MODEL_DEFINITION),
	...prefixed("modelOverrides.*.", MODEL_OVERRIDE),
};

/** models.json, keyed by schema path: `.` nests, `[]` is an array item, `.{key}` a record key, `.*` a record value. */
export const MODELS_JSON_FIELD_CLASSES: Readonly<Record<string, FieldClass>> = {
	"disabledProviders[]": "public",
	"providers.{key}": "public",
	...prefixed("providers.*.", PROVIDER),
};

/** Fields the runtime types add on top of the models.json schema (`model-config.ts`). */
export const MODELS_JSON_TYPE_ONLY_FIELDS: Readonly<Record<string, FieldClass>> = {
	"providers.*.models[].samplingParams.{key}": "public",
	"providers.*.models[].samplingParams.*": "forces-device",
	"providers.*.modelOverrides.*.samplingParams.{key}": "public",
	"providers.*.modelOverrides.*.samplingParams.*": "forces-device",
};

export function classifyModelsJsonField(path: string): FieldClass | undefined {
	return MODELS_JSON_FIELD_CLASSES[path] ?? MODELS_JSON_TYPE_ONLY_FIELDS[path];
}

function fields(fieldClass: FieldClass, paths: readonly string[]): Record<string, FieldClass> {
	return Object.fromEntries(paths.map((path) => [path, fieldClass]));
}

function prefixed(prefix: string, table: Readonly<Record<string, FieldClass>>): Record<string, FieldClass> {
	return Object.fromEntries(Object.entries(table).map(([path, fieldClass]) => [`${prefix}${path}`, fieldClass]));
}
