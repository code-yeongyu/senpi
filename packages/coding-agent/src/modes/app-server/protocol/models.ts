import type { ReasoningEffort } from "./base.ts";

export type InputModality = "text" | "image" | "audio";
export type ModelUpgradeInfo = {
	readonly model: string;
	readonly upgradeCopy: string | null;
	readonly modelLink: string | null;
	readonly migrationMarkdown: string | null;
};
export type ModelAvailabilityNux = { readonly message: string };
export type ReasoningEffortOption = {
	readonly reasoningEffort: ReasoningEffort;
	readonly description: string;
};
export type ModelServiceTier = {
	readonly id: string;
	readonly name: string;
	readonly description: string;
};
export type Model = {
	readonly id: string;
	readonly model: string;
	readonly upgrade: string | null;
	readonly upgradeInfo: ModelUpgradeInfo | null;
	readonly availabilityNux: ModelAvailabilityNux | null;
	readonly displayName: string;
	readonly description: string;
	readonly hidden: boolean;
	readonly supportedReasoningEfforts: readonly ReasoningEffortOption[];
	readonly defaultReasoningEffort: ReasoningEffort;
	readonly inputModalities: readonly InputModality[];
	readonly supportsPersonality: boolean;
	readonly additionalSpeedTiers: readonly string[];
	readonly serviceTiers: readonly ModelServiceTier[];
	readonly defaultServiceTier: string | null;
	readonly isDefault: boolean;
};

export type ModelListParams = {
	readonly cursor?: string | null;
	readonly limit?: number | null;
	readonly includeHidden?: boolean | null;
};
export type ModelListResponse = { readonly data: readonly Model[]; readonly nextCursor: string | null };
