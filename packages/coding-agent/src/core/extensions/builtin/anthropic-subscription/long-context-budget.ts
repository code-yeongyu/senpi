import type { Context } from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { CLAUDE_SAFETY_MARGIN_TOKENS } from "../compaction/claude-safety-margin.ts";
import { coldSeedCalibration, estimateColdSeedTokens } from "./cold-seed-budget.ts";
import type { ContentBlockParam } from "./sdk-boundary.ts";

/** Budget a fallback without scaling already billed usage by the cold-seed ratio. */
export function estimateLongContextFallbackTokens(
	context: Context,
	blocks: readonly ContentBlockParam[],
	sessionId: string | undefined,
): number {
	const usage = estimateContextTokens(context.messages);
	const calibration = coldSeedCalibration(sessionId);
	return (
		Math.max(
			usage.usageTokens + Math.ceil(usage.trailingTokens * calibration),
			Math.ceil(estimateColdSeedTokens(context, blocks) * calibration),
		) + (usage.lastUsageIndex === null ? CLAUDE_SAFETY_MARGIN_TOKENS : 0)
	);
}
