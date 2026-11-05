import type { Model } from "@earendil-works/pi-ai";
import type { CompactionPreparation, CompactionResult } from "../../../compaction/index.ts";
import type { SessionEntry } from "../../../session-manager.ts";
import { resolveCompactionGeometry } from "./orchestration.ts";
import type { CompactionYield } from "./policy.ts";
import { projectCompactedContextTokens } from "./rejected-recovery.ts";

export interface WarmCandidateFit {
	fits: boolean;
	projectedTokens: number;
	budgetTokens: number;
}

/**
 * Whether a finished warm summary is still worth applying as-is (senpi#5481): applied to the
 * current branch, the summary plus everything after its anchor must land below the point where
 * speculation starts (`threshold - lead`), so applying it does not leave the session one turn
 * away from compacting again.
 */
export function assessWarmCandidateFit(input: {
	branchEntries: SessionEntry[];
	compaction: CompactionResult;
	model: Model<string>;
	contextWindow: number;
	settings: CompactionPreparation["settings"];
	lastYield?: CompactionYield;
}): WarmCandidateFit {
	const geometry = resolveCompactionGeometry({
		contextWindow: input.contextWindow,
		settings: input.settings,
		lastYield: input.lastYield,
	});
	const budgetTokens = Math.max(0, Math.floor(geometry.thresholdTokens - geometry.leadTokens));
	const projectedTokens = projectCompactedContextTokens(input.branchEntries, input.compaction, true, input.model);
	return { fits: projectedTokens <= budgetTokens, projectedTokens, budgetTokens };
}
