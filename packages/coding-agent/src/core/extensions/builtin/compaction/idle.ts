import type { CompactionSettings } from "../../../compaction/index.ts";
import type { ContextUsage, ExtensionMode } from "../../types.ts";
import { type CompactionYield, shouldTriggerCompaction } from "./policy.ts";
import { WARM_GENERATION_FLOOR_RATIO } from "./speculation-lead.ts";

export const IDLE_COMPACTION_INSTRUCTIONS =
	"Proactively compact at idle before the next agent turn, while the user is not waiting.";

const PERSISTENT_MODES: ReadonlySet<ExtensionMode> = new Set(["tui", "rpc", "app-server"]);

export interface IdleCompactionDecision {
	willRetry: boolean;
	aborted: boolean;
	settings: CompactionSettings;
	usage: ContextUsage | undefined;
	contextWindow: number;
	breakerTripped: boolean;
	lastYield?: CompactionYield;
	mode: ExtensionMode;
}

function isIdleEligible(decision: IdleCompactionDecision): boolean {
	if (decision.willRetry) return false;
	if (decision.aborted) return false;
	if (!PERSISTENT_MODES.has(decision.mode)) return false;
	if (!decision.settings.enabled) return false;
	if (decision.settings.idleCompactionEnabled === false) return false;
	if (decision.breakerTripped) return false;
	if (!decision.usage) return false;
	return decision.usage.tokens !== null;
}

export function shouldRunIdleCompaction(decision: IdleCompactionDecision): boolean {
	if (!isIdleEligible(decision) || !decision.usage) return false;
	return shouldTriggerCompaction(decision.usage, decision.contextWindow, decision.settings, decision.lastYield);
}

export function shouldWarmAtIdle(decision: IdleCompactionDecision): boolean {
	if (!isIdleEligible(decision) || !decision.usage || decision.usage.tokens === null) return false;
	return decision.usage.tokens >= decision.contextWindow * WARM_GENERATION_FLOOR_RATIO;
}
