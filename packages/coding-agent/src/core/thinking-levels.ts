import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
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
