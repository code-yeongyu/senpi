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
