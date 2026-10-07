import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelChangeOrigin } from "../../../model-change-origin.ts";
import type { ModelUsabilityBudgetProjection } from "./model-usability-budget.ts";

export interface PendingModelSwitch {
	readonly model: Model<Api>;
	readonly projection: ModelUsabilityBudgetProjection;
	readonly persistDefault: boolean;
	/** What asked for the switch; the applied switch records it as held (senpi#2870). */
	readonly origin: ModelChangeOrigin;
	readonly notice: string;
}

export function createPendingModelSwitch(input: {
	model: Model<Api>;
	projection: ModelUsabilityBudgetProjection;
	persistDefault: boolean;
	origin: ModelChangeOrigin;
}): PendingModelSwitch {
	return {
		...input,
		notice: `${input.model.id} needs ${input.projection.shortfallTokens} fewer tokens than this conversation holds. It is compacted on your next message, and the switch applies after that.`,
	};
}

/**
 * The keep-recent size the PENDING model's window is designed around, recovered
 * from the projection's own post-compaction geometry. The deferred compaction
 * aims here while the summary request is still issued by the model that can hold
 * the transcript today, so geometry and summarizer come from different models on
 * purpose: aiming at the current model's geometry, or merely at whatever still
 * fits, leaves no room for the summary the compaction is about to add.
 */
export function pendingSwitchKeepRecentTokens(projection: ModelUsabilityBudgetProjection): number {
	const overheadTokens = projection.requiredTokens - projection.liveContextTokens;
	return Math.max(1, projection.postCompactionRequiredTokens - overheadTokens);
}
