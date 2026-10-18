import type { ModelCost, ThinkingLevelMap } from "../src/types.ts";
import type { Model } from "../src/types.ts";
import baiMetadataJson from "./bai-models.json" with { type: "json" };

export type BaiApi = "openai-responses" | "openai-completions" | "anthropic-messages";

type BaiInput = ("text" | "image" | "video")[];

interface BaiModelMetadata {
	api: BaiApi;
	contextWindow: number;
	maxTokens: number;
	input: BaiInput;
	cost: ModelCost;
	thinkingLevelMap?: ThinkingLevelMap;
}

const BAI_BASE_URL = "https://api.b.ai/v1";
const BAI_ANTHROPIC_BASE_URL = "https://api.b.ai";

const baiMetadata = baiMetadataJson as unknown as Readonly<Record<string, BaiModelMetadata>>;

/** IDs whose segments do not survive the generic formatter; names follow B.AI's pricing table. */
const BAI_MODEL_NAMES: Record<string, string> = {
	"muse-spark-1-3": "Muse Spark 1.3",
};

function formatBaiModelName(modelId: string): string {
	const explicit = BAI_MODEL_NAMES[modelId];
	if (explicit) return explicit;

	const [family, version, ...rest] = modelId.split("-");
	const familyName: Record<string, string> = {
		claude: "Claude",
		deepseek: "DeepSeek",
		gemini: "Gemini",
		glm: "GLM",
		gpt: "GPT",
		grok: "Grok",
		hy3: "HY3",
		hy4: "HY4",
		kimi: "Kimi",
		mimo: "MiMo",
		minimax: "MiniMax",
		"qwen3.6": "Qwen3.6",
		"qwen3.7": "Qwen3.7",
		"qwen3.8": "Qwen3.8",
	};
	const displayFamily = familyName[family] ?? family.toUpperCase();
	const displayRest = rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");

	if (family === "gpt" || family === "glm") {
		return `${displayFamily}-${version}${displayRest ? ` ${displayRest}` : ""}`;
	}

	const suffix = [version, ...rest]
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
	return suffix ? `${displayFamily} ${suffix}` : displayFamily;
}

/**
 * B.AI `/v1/models` returns credential-scoped IDs without model capabilities.
 * This generated-catalog source pins B.AI's published standard metadata so the
 * runtime provider can filter the catalog by entitlement without guessing.
 *
 * Sources (verified 2026-09-18):
 * - https://docs.b.ai/sitemap.xml enumerates the per-model pages; there is no
 *   `/llmservice/models/` index page.
 * - https://docs.b.ai/llmservice/models/<slug>/ for context window, max output,
 *   modalities, and reasoning levels.
 * - https://docs.b.ai/llmservice/pricing-and-usage/ for standard reference
 *   prices in USD per 1M tokens, in Input / Cache Write / Cache Read / Output
 *   column order. Promotional and DeepSeek idle rates are deliberately not
 *   recorded here; the catalog carries standard prices only.
 *
 * These values are the generator's input, not the shipped result: the shared
 * passes in `generate-models.ts` still cap context windows, merge thinking
 * levels, and apply cross-provider overrides afterwards.
 */
export function getBaiModels(): Model<BaiApi>[] {
	return Object.entries(baiMetadata).map(([id, metadata]) => ({
		id,
		name: formatBaiModelName(id),
		api: metadata.api,
		provider: "bai",
		baseUrl: metadata.api === "anthropic-messages" ? BAI_ANTHROPIC_BASE_URL : BAI_BASE_URL,
		reasoning: metadata.thinkingLevelMap !== undefined,
		...(metadata.thinkingLevelMap ? { thinkingLevelMap: metadata.thinkingLevelMap } : {}),
		input: metadata.input,
		cost: metadata.cost,
		contextWindow: metadata.contextWindow,
		maxTokens: metadata.maxTokens,
		...(metadata.api === "openai-completions"
			? {
					compat: {
						supportsDeveloperRole: false,
					},
				}
			: {}),
	}));
}
