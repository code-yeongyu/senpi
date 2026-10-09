import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { SettingsManager } from "../../../settings-manager.ts";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "../../types.ts";

const FLAG_NAME = "no-recommended-models";
// Only implicit fallbacks auto-switch. A `settings` provenance means the user explicitly
// configured a system default model, which must be respected rather than overridden.
const AUTO_SWITCH_PROVENANCE = new Set<NonNullable<SessionStartEvent["initialModelProvenance"]>>([
	"provider-default",
	"first-available",
]);
const MODEL_ID_SUFFIXES = ["-ultrafast", "-unlocked", "-256k", "-fast"] as const;

// Provider lanes ranked like the category and model-profile chains: the subscription lane first.
// A shipped rung is served ONLY by its ranked lanes, so gateway aggregators (opengateway,
// openrouter, vercel-ai-gateway) and other resellers are never pulled in. A `recommendedModels`
// override id outside this table carries no ranking and any provider may serve it.
const CLAUDE_PROVIDERS = [
	"anthropic-subscription",
	"anthropic",
	"anthropic-api",
	"github-copilot",
	"opencode",
] as const;
const KIMI_PROVIDERS = ["kimi-coding", "kimi-for-coding", "moonshotai", "opencode-go"] as const;
const GPT_PROVIDERS = ["chatgpt-subscription", "openai", "github-copilot", "opencode"] as const;
const GLM_PROVIDERS = ["zai-coding-plan", "opencode-go"] as const;

export const RECOMMENDED_DEFAULT_MODELS = [
	["claude-opus-5-5", "medium", CLAUDE_PROVIDERS],
	["claude-fable-5-1", "xhigh", CLAUDE_PROVIDERS],
	["kimi-k3", "max", KIMI_PROVIDERS],
	["gpt-6-astra", "xhigh", GPT_PROVIDERS],
	["gpt-6.1-sol", "medium", GPT_PROVIDERS],
	["glm-5.3", "max", GLM_PROVIDERS],
] as const satisfies ReadonlyArray<readonly [string, ThinkingLevel, readonly string[]]>;

type RecommendedModel = { modelId: string; thinkingLevel: ThinkingLevel; providers: readonly string[] };

const DEFAULT_RECOMMENDATIONS: readonly RecommendedModel[] = RECOMMENDED_DEFAULT_MODELS.map(
	([modelId, thinkingLevel, providers]) => ({ modelId, thinkingLevel, providers }),
);
const DEFAULT_RECOMMENDATIONS_BY_MODEL_ID = new Map(
	DEFAULT_RECOMMENDATIONS.map((recommendation) => [recommendation.modelId, recommendation]),
);

export function canonicalModelId(modelId: string): string {
	let canonical = modelId.toLowerCase();
	let strippedSuffix = true;
	while (strippedSuffix) {
		strippedSuffix = false;
		for (const suffix of MODEL_ID_SUFFIXES) {
			if (canonical.endsWith(suffix)) {
				canonical = canonical.slice(0, -suffix.length);
				strippedSuffix = true;
				break;
			}
		}
	}
	return canonical === "k3" ? "kimi-k3" : canonical;
}

function recommendationsFor(configuredModelIds: string[] | undefined): readonly RecommendedModel[] {
	if (configuredModelIds === undefined) {
		return DEFAULT_RECOMMENDATIONS;
	}
	return configuredModelIds
		.map(canonicalModelId)
		.filter((modelId) => modelId.length > 0)
		.map(
			(modelId): RecommendedModel =>
				DEFAULT_RECOMMENDATIONS_BY_MODEL_ID.get(modelId) ?? { modelId, thinkingLevel: "medium", providers: [] },
		);
}

function findAvailableRecommendation(
	recommendations: readonly RecommendedModel[],
	ctx: ExtensionContext,
): { recommendation: RecommendedModel; model: Model<Api> } | undefined {
	const available = ctx.modelRegistry.getAvailable().filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
	for (const recommendation of recommendations) {
		const candidates = available.filter((candidate) => canonicalModelId(candidate.id) === recommendation.modelId);
		const model =
			recommendation.providers.length === 0
				? candidates[0]
				: recommendation.providers
						.map((provider) => candidates.find((candidate) => candidate.provider === provider))
						.find((candidate) => candidate !== undefined);
		if (model) {
			return { recommendation, model };
		}
	}
	return undefined;
}

function isRecommended(model: Model<Api> | undefined, recommendations: readonly RecommendedModel[]): boolean {
	return (
		model !== undefined &&
		recommendations.some((recommendation) => canonicalModelId(model.id) === recommendation.modelId)
	);
}

function nonRecommendedModelWarning(model: Model<Api> | undefined): string {
	return `Non-recommended model '${model?.id ?? "<none>"}': odd behavior is the default state; a working session is the anomaly.`;
}

export default function recommendedModelsExtension(pi: ExtensionAPI): void {
	pi.registerFlag(FLAG_NAME, {
		type: "boolean",
		default: false,
		description: "Disable recommended model selection for this run.",
	});

	let initialized = false;
	let disabled = false;
	let disarmed = false;
	let automaticSelection = false;
	let warningShown = false;
	let canAutoSwitch = false;
	let recommendations: readonly RecommendedModel[] = DEFAULT_RECOMMENDATIONS;

	const warnWhenNoRecommendationIsAvailable = (ctx: ExtensionContext): void => {
		if (warningShown || findAvailableRecommendation(recommendations, ctx)) {
			return;
		}
		warningShown = true;
		ctx.ui.notify(nonRecommendedModelWarning(ctx.model), "warning");
	};

	pi.on("session_start", async (event, ctx) => {
		if (initialized) {
			return;
		}
		initialized = true;

		const settingsManager = SettingsManager.create(ctx.cwd);
		disabled = pi.getFlag(FLAG_NAME) === true || settingsManager.getWarnings().offRecommendedModel === true;
		recommendations = recommendationsFor(settingsManager.getRecommendedModels());
		canAutoSwitch =
			ctx.mode !== "app-server" &&
			event.initialModelProvenance !== undefined &&
			AUTO_SWITCH_PROVENANCE.has(event.initialModelProvenance);
		if (disabled || !canAutoSwitch || isRecommended(ctx.model, recommendations)) {
			return;
		}

		const target = findAvailableRecommendation(recommendations, ctx);
		if (!target) {
			warnWhenNoRecommendationIsAvailable(ctx);
			return;
		}

		const persistAsDefault = ctx.mode === "tui";
		automaticSelection = true;
		try {
			const switched = persistAsDefault ? await pi.setModel(target.model) : await pi.setSessionModel(target.model);
			if (!switched) {
				warnWhenNoRecommendationIsAvailable(ctx);
				return;
			}
			if (persistAsDefault) {
				pi.setThinkingLevel(target.recommendation.thinkingLevel);
			} else {
				pi.setSessionThinkingLevel(target.recommendation.thinkingLevel);
			}
			ctx.ui.notify(`Switched to recommended model '${target.model.id}'.`, "info");
		} finally {
			automaticSelection = false;
		}
	});

	pi.on("model_select", (event, ctx) => {
		if (!initialized || disabled || disarmed || automaticSelection || !canAutoSwitch) {
			return;
		}
		if (event.source === "set" || event.source === "cycle") {
			disarmed = true;
			return;
		}
		if (!isRecommended(event.model, recommendations)) {
			warnWhenNoRecommendationIsAvailable(ctx);
		}
	});
}
