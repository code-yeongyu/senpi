import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ModelThinkingLevel, ThinkingSelection } from "@earendil-works/pi-ai";
import {
	getSupportedThinkingLevels as getSupportedModelThinkingLevels,
	supportsMax as modelSupportsMax,
	supportsXhigh as modelSupportsXhigh,
} from "@earendil-works/pi-ai";

/**
 * Tier detection is owned by `packages/ai`, which already treats an explicit `thinkingLevelMap` as
 * authoritative and infers tiers from the model id only when no map is present. These wrappers keep
 * the coding-agent's `ThinkingLevel` vocabulary without duplicating the capability rules.
 */
export function supportsXhigh(model: Model<Api>): boolean {
	return modelSupportsXhigh(model);
}

export function supportsMax(model: Model<Api>): boolean {
	return modelSupportsMax(model);
}

export function getSupportedThinkingLevels(model: Model<Api>): ThinkingLevel[] {
	const supportedLevels = getSupportedModelThinkingLevels(model);
	return supportedLevels.length > 0 ? supportedLevels : ["off"];
}

/** Why an explicit thinking selection runs at a lower level than the one requested (senpi#2395). */
export type ThinkingClampReason = "model-not-reasoning" | "level-unsupported";

/** An explicit selection that also records the requested level when a clamp changed it. */
export interface ClampedThinkingSelection extends ThinkingSelection {
	readonly requested?: ModelThinkingLevel;
	readonly clampReason?: ThinkingClampReason;
}

/** One clamp of an explicit request, as shown to the user. */
export interface ThinkingClampNotice {
	provider: string;
	modelId: string;
	requestedLevel: ModelThinkingLevel;
	appliedLevel: ModelThinkingLevel;
	reason: ThinkingClampReason;
}

/**
 * Apply the effective `level` to an explicit selection. When it differs from `requested`, the selection keeps
 * the requested level and the clamp reason instead of reading as if `level` had been chosen.
 */
export function clampThinkingSelection(
	selection: ThinkingSelection | undefined,
	requested: ModelThinkingLevel,
	level: ModelThinkingLevel,
	model: Model<Api> | undefined,
): ThinkingSelection | undefined {
	if (selection === undefined) return undefined;
	const { requested: _staleRequested, clampReason: _staleReason, ...base } = selection as ClampedThinkingSelection;
	if (requested === level || model === undefined) return { ...base, level };
	const clamped: ClampedThinkingSelection = {
		...base,
		level,
		requested,
		clampReason: model.reasoning ? "level-unsupported" : "model-not-reasoning",
	};
	return clamped;
}

export function getThinkingClampNotice(
	selection: ThinkingSelection | undefined,
	model: Model<Api> | undefined,
): ThinkingClampNotice | undefined {
	const clamped = selection as ClampedThinkingSelection | undefined;
	if (model === undefined || clamped?.requested === undefined || clamped.clampReason === undefined) return undefined;
	return {
		provider: model.provider,
		modelId: model.id,
		requestedLevel: clamped.requested,
		appliedLevel: clamped.level,
		reason: clamped.clampReason,
	};
}

export function formatThinkingClampWarning(notice: ThinkingClampNotice): string {
	const model = `${notice.provider}/${notice.modelId}`;
	if (notice.reason === "model-not-reasoning") {
		return `Thinking level "${notice.requestedLevel}" was requested, but ${model} is not marked as a reasoning model, so thinking is "${notice.appliedLevel}". If the model supports reasoning, set "reasoning": true for it in models.json.`;
	}
	return `Thinking level "${notice.requestedLevel}" is not available on ${model}; using "${notice.appliedLevel}".`;
}

/** Capability classes used by capability-aware reasoning commands. */
export type ReasoningCapabilityKind = "none" | "always-on" | "on-off" | "graded";

export interface ReasoningCapability {
	kind: ReasoningCapabilityKind;
	/** Supported levels, always non-empty; includes "off" when the model can disable reasoning. */
	levels: ThinkingLevel[];
	/** Supported levels excluding "off" (empty for kind "none"). */
	nonOffLevels: ThinkingLevel[];
}

/**
 * Classify a model's reasoning capability purely from `model.reasoning` and its supported thinking
 * levels — never from the model id or thinkingFormat/compat config.
 *
 * - reasoning=false -> "none"
 * - "off" is not supported -> "always-on"
 * - exactly one non-off level -> "on-off"
 * - otherwise -> "graded"
 *
 * Malformed input (e.g. a thinkingLevelMap that vetoes every level) cannot throw: the wrapper's
 * ["off"] fallback means the model degrades to kind "none" with levels ["off"].
 */
export function classifyReasoningCapability(model: Model<Api>): ReasoningCapability {
	if (!model.reasoning) {
		return { kind: "none", levels: ["off"], nonOffLevels: [] };
	}
	const levels = getSupportedThinkingLevels(model);
	const nonOffLevels = levels.filter((level) => level !== "off");
	if (!levels.includes("off")) {
		return { kind: "always-on", levels, nonOffLevels };
	}
	if (nonOffLevels.length === 1) {
		return { kind: "on-off", levels, nonOffLevels };
	}
	if (nonOffLevels.length === 0) {
		return { kind: "none", levels, nonOffLevels };
	}
	return { kind: "graded", levels, nonOffLevels };
}
