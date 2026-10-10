import { convertToLlm } from "../../../messages.ts";
import type { ContextEvent, ExtensionContext } from "../../types.ts";
import {
	type ContextReductionState,
	createContextReductionState,
	reduceContextWithFrontier,
} from "./context-reduction.ts";
import { markOpenAiRemoteReplayBoundary } from "./openai-remote.ts";
import { isOpenAiRemoteCompactionModel } from "./openai-remote-model.ts";
import { admitContextToolResults, injectTokenBudgetReminder } from "./orchestration.ts";
import { estimateTotalTokens } from "./overflow-retry.ts";
import { repairOrphanedToolResults } from "./repair-tool-pairs.ts";
import { type EmergencyPruneLatch, hardLimitEmergencyPrune } from "./speculative.ts";

export function buildCompactionContext(input: {
	event: ContextEvent;
	ctx: ExtensionContext;
	contextWindow: number;
	/**
	 * Context window minus the model's output reserve. The emergency prune budgets against the
	 * space a request can actually occupy, so it must not see the full window.
	 */
	promptContextWindow: number;
	toolAdmissionEnabled: boolean;
	breakerFallback: boolean;
	laneOwnsCompaction: boolean;
	contextReductionState?: ContextReductionState;
	contextOverheadTokens?: number;
	/** The smaller of the compaction threshold and the reserved prompt budget. */
	reductionCeilingTokens?: number;
	/**
	 * The lane replays into a resident transcript that only accepts appends, so no per-turn reduction
	 * runs, including the breaker fallback: a rewrite of an already-sent message diverges it.
	 */
	appendOnlyTranscript?: boolean;
	emergencyPruneLatch: EmergencyPruneLatch;
	/** Emits the compaction log event for a real emergency prune at its one true site. */
	logEmergencyPrune?: (fields: { route: string; tokensBefore: number; tokens: number }) => void;
	reminder?: string;
}) {
	if (input.laneOwnsCompaction) {
		return repairOrphanedToolResults(convertToLlm(input.event.messages));
	}
	const admittedMessages = admitContextToolResults(
		input.event.messages,
		input.contextWindow,
		input.toolAdmissionEnabled,
	);
	const sourceMessages =
		!input.laneOwnsCompaction &&
		input.appendOnlyTranscript !== true &&
		!isOpenAiRemoteCompactionModel(input.ctx.model)
			? reduceContextWithFrontier(admittedMessages, input.contextReductionState ?? createContextReductionState(), {
					unreducedMessages: input.event.messages,
					contextWindow: input.contextWindow,
					ceilingTokens: input.reductionCeilingTokens ?? input.promptContextWindow,
					overheadTokens: input.contextOverheadTokens ?? 0,
					force: input.breakerFallback,
				})
			: admittedMessages;
	const emergency = input.laneOwnsCompaction
		? { messages: sourceMessages, needsAggressiveCompaction: false }
		: hardLimitEmergencyPrune(sourceMessages, input.promptContextWindow, input.emergencyPruneLatch);
	// This is the ONE site that actually prunes, so the emergency_prune counter must be
	// emitted here. Engagement shows up either as a rewritten message array or as
	// needsAggressiveCompaction when nothing prunable remained.
	if (!input.laneOwnsCompaction && (emergency.needsAggressiveCompaction || emergency.messages !== sourceMessages)) {
		input.logEmergencyPrune?.({
			route: "context-event",
			tokensBefore: estimateTotalTokens(sourceMessages),
			tokens: estimateTotalTokens(emergency.messages),
		});
	}
	const marked = markOpenAiRemoteReplayBoundary(emergency.messages, {
		model: input.ctx.model,
		branchEntries: input.ctx.sessionManager.getBranch(),
	});
	const reminded = injectTokenBudgetReminder(marked, input.reminder);
	return repairOrphanedToolResults(convertToLlm(reminded));
}
