import { type Api, estimateContextTokens, type Model, normalizeContext, type Tool } from "@earendil-works/pi-ai";
import { type CompactionPreparation, DEFAULT_COMPACTION_SETTINGS } from "../../../compaction/index.ts";
import { getPromptContextWindow } from "./extension-wiring.ts";
import { resolveCompactionGeometry } from "./orchestration.ts";
import { baseThresholdRatioForWindow, computeEffectiveKeepRecentTokens } from "./policy.ts";

interface ModelSafetyMarginProfile {
	readonly id: string;
	readonly tokens: number;
	readonly providers?: readonly string[];
	readonly familyMarkers?: readonly string[];
}

/** Measured conversation runway by shipped prompt family, rounded up to a 4K token boundary. */
const MODEL_SAFETY_MARGIN_PROFILES: readonly ModelSafetyMarginProfile[] = [
	{ id: "anthropic", tokens: 16_384, providers: ["anthropic"], familyMarkers: ["claude"] },
	{ id: "openai-reasoning", tokens: 16_384, providers: ["openai"], familyMarkers: ["gpt-5", "o1", "o3", "o4"] },
	{ id: "google", tokens: 12_288, providers: ["google"], familyMarkers: ["gemini"] },
	{ id: "deepseek", tokens: 12_288, providers: ["deepseek"], familyMarkers: ["deepseek"] },
	{ id: "default", tokens: 8_192 },
];

export type ModelUsabilityAdmission = "start" | "resume" | "switch";

/**
 * Whether a model can serve this session, and at what cost (#1873).
 *
 * - `fits-now` — the assembled budget already fits the window.
 * - `fits-after-compaction` — it does not fit now, but the window can hold the
 *   fixed overhead plus a reduced transcript, so reducing the transcript makes
 *   the model usable. This is a capability statement, not a permission: whether
 *   the session may reduce (and whether it summarizes or slices) stays with the
 *   caller, which is the split `sdk.ts` already makes on resume.
 * - `impossible` — the fixed overhead leaves no room for any transcript, so no
 *   amount of reduction helps and refusing is the only correct answer.
 */
export type ModelUsabilityVerdict = "fits-now" | "fits-after-compaction" | "impossible";

export interface ModelUsabilityBudgetProjection {
	readonly model: string;
	readonly contextWindow: number;
	readonly liveContextTokens: number;
	readonly systemPromptTokens: number;
	readonly activeToolSchemaTokens: number;
	readonly outputReserveTokens: number;
	readonly compactionReserveTokens: number;
	readonly speculationLeadTokens: number;
	readonly safetyMarginTokens: number;
	readonly safetyMarginProfile: string;
	readonly requiredTokens: number;
	readonly shortfallTokens: number;
	readonly usable: boolean;
	readonly admission: ModelUsabilityAdmission;
	readonly verdict: ModelUsabilityVerdict;
	/** Overhead plus the post-compaction keep-recent floor; the `impossible` boundary. */
	readonly postCompactionRequiredTokens: number;
	/** Live context plus the overhead a summarization request itself must carry. */
	readonly compactionRequiredTokens: number;
}

export interface ModelUsabilityBudgetInput<TApi extends Api> {
	readonly model: Model<TApi>;
	readonly systemPrompt: string;
	readonly tools: readonly Tool[];
	readonly liveContextTokens?: number;
	readonly compaction: CompactionPreparation["settings"];
	/** Defaults to true. Resume/startup must pass false so speculation can run after admit. */
	readonly includeSpeculationLead?: boolean;
	readonly admission?: ModelUsabilityAdmission;
}

function matchesFamilyMarker(modelId: string, marker: string): boolean {
	const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[/.:_-])${escapedMarker}(?=$|[^a-z0-9])`).test(modelId.toLowerCase());
}

function resolveSafetyMarginProfile<TApi extends Api>(model: Model<TApi>): ModelSafetyMarginProfile {
	return (
		MODEL_SAFETY_MARGIN_PROFILES.find(
			(profile) =>
				profile.id !== "default" &&
				(profile.providers?.includes(model.provider) === true ||
					profile.familyMarkers?.some((marker) => matchesFamilyMarker(model.id, marker)) === true),
		) ?? MODEL_SAFETY_MARGIN_PROFILES[MODEL_SAFETY_MARGIN_PROFILES.length - 1]
	);
}

export function projectModelUsabilityBudget<TApi extends Api>(
	input: ModelUsabilityBudgetInput<TApi>,
): ModelUsabilityBudgetProjection {
	const liveContextTokens = input.liveContextTokens ?? 0;
	const systemPromptTokens = estimateContextTokens(
		normalizeContext({ systemPrompt: input.systemPrompt, messages: [], tools: [] }),
	).tokens;
	const promptAndToolsTokens = estimateContextTokens(
		normalizeContext({ systemPrompt: input.systemPrompt, messages: [], tools: [...input.tools] }),
	).tokens;
	const activeToolSchemaTokens = promptAndToolsTokens - systemPromptTokens;
	const outputReserveTokens =
		input.model.contextWindow - getPromptContextWindow(input.model.contextWindow, input.model.maxTokens);
	const geometry = resolveCompactionGeometry({ contextWindow: input.model.contextWindow, settings: input.compaction });
	const compactionReserveTokens = input.compaction.enabled ? geometry.reserveTokens : 0;
	const includeSpeculationLead = input.includeSpeculationLead !== false;
	const speculationLeadTokens =
		includeSpeculationLead && input.compaction.enabled && input.compaction.speculativeEnabled !== false
			? geometry.leadTokens
			: 0;
	const safetyMargin = resolveSafetyMarginProfile(input.model);
	const baseRequiredTokens =
		systemPromptTokens +
		activeToolSchemaTokens +
		outputReserveTokens +
		compactionReserveTokens +
		speculationLeadTokens +
		safetyMargin.tokens;
	const uncompactedRequiredTokens = liveContextTokens + baseRequiredTokens;
	const admission = input.admission ?? (liveContextTokens > 0 ? "switch" : "start");

	// #1873: both reduction geometries are projected for every admission, so a
	// caller can tell "needs a smaller transcript" from "can never serve" without
	// re-deriving the arithmetic. Only the `usable` relaxation below stays scoped
	// to resume, keeping the admission contract other callers already depend on.
	const compactionRequiredTokens =
		liveContextTokens + systemPromptTokens + activeToolSchemaTokens + compactionReserveTokens + safetyMargin.tokens;
	const keepRecentSetting = input.compaction.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
	const effectiveKeepRecentTokens = computeEffectiveKeepRecentTokens(
		keepRecentSetting,
		input.model.contextWindow,
		baseThresholdRatioForWindow(input.model.contextWindow),
	);
	const postCompactionRequiredTokens = effectiveKeepRecentTokens + baseRequiredTokens;

	let requiredTokens = uncompactedRequiredTokens;
	let shortfallTokens = Math.max(0, requiredTokens - input.model.contextWindow);
	let usable = shortfallTokens === 0;
	const verdict: ModelUsabilityVerdict = usable
		? "fits-now"
		: postCompactionRequiredTokens <= input.model.contextWindow
			? "fits-after-compaction"
			: "impossible";

	if (!usable && admission === "resume" && input.compaction.enabled && !includeSpeculationLead) {
		if (
			compactionRequiredTokens <= input.model.contextWindow &&
			postCompactionRequiredTokens <= input.model.contextWindow
		) {
			requiredTokens = Math.max(compactionRequiredTokens, postCompactionRequiredTokens);
			shortfallTokens = 0;
			usable = true;
		}
	}

	return {
		model: `${input.model.provider}/${input.model.id}`,
		contextWindow: input.model.contextWindow,
		liveContextTokens,
		systemPromptTokens,
		activeToolSchemaTokens,
		outputReserveTokens,
		compactionReserveTokens,
		speculationLeadTokens,
		safetyMarginTokens: safetyMargin.tokens,
		safetyMarginProfile: safetyMargin.id,
		requiredTokens,
		shortfallTokens,
		usable: shortfallTokens === 0,
		admission,
		verdict,
		postCompactionRequiredTokens,
		compactionRequiredTokens,
	};
}

export class ModelUsabilityBudgetError extends Error {
	readonly projection: ModelUsabilityBudgetProjection;

	constructor(projection: ModelUsabilityBudgetProjection) {
		const breakdown = `system prompt ${projection.systemPromptTokens}, active tool schemas ${projection.activeToolSchemaTokens}, output reserve ${projection.outputReserveTokens}, compaction reserve ${projection.compactionReserveTokens}, speculation lead ${projection.speculationLeadTokens}, safety margin ${projection.safetyMarginTokens} [${projection.safetyMarginProfile}]`;
		const message =
			projection.admission === "resume"
				? `Model "${projection.model}" cannot resume: target context window ${projection.contextWindow} tokens is ${projection.shortfallTokens} tokens short of the ${projection.requiredTokens}-token requirement (live context ${projection.liveContextTokens}, ${breakdown}).`
				: projection.admission === "switch"
					? `Model "${projection.model}" cannot switch: target context window ${projection.contextWindow} tokens is ${projection.shortfallTokens} tokens short of the ${projection.requiredTokens}-token requirement (live context ${projection.liveContextTokens}, ${breakdown}). Compact the session, then revalidate and retry the model switch.`
					: `Model "${projection.model}" cannot start: context window ${projection.contextWindow} tokens is ${projection.shortfallTokens} tokens short of the ${projection.requiredTokens}-token minimum (${breakdown}).`;
		super(message);
		this.name = "ModelUsabilityBudgetError";
		this.projection = projection;
	}
}
