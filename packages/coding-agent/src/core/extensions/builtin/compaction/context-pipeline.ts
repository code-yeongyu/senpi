import { convertToLlm } from "../../../messages.ts";
import type { ContextEvent, ExtensionContext } from "../../types.ts";
import {
	BUILTIN_CONTEXT_REDUCTION_OPTIONS,
	reduceContextMessages,
	shouldApplyContextReduction,
} from "./context-reduction.ts";
import { markOpenAiRemoteReplayBoundary } from "./openai-remote.ts";
import { isOpenAiRemoteCompactionModel } from "./openai-remote-model.ts";
import { admitContextToolResults } from "./orchestration.ts";
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
	emergencyPruneLatch: EmergencyPruneLatch;
}) {
	const admittedMessages = admitContextToolResults(
		input.event.messages,
		input.contextWindow,
		input.toolAdmissionEnabled,
	);
	const sourceMessages =
		!input.laneOwnsCompaction &&
		(input.breakerFallback ||
			shouldApplyContextReduction({
				usageTokens: input.ctx.getContextUsage()?.tokens ?? null,
				contextWindow: input.contextWindow,
				isProviderNativeCompactionPath: isOpenAiRemoteCompactionModel(input.ctx.model) || input.laneOwnsCompaction,
			}))
			? reduceContextMessages(admittedMessages, BUILTIN_CONTEXT_REDUCTION_OPTIONS).messages
			: admittedMessages;
	const emergency = input.laneOwnsCompaction
		? { messages: sourceMessages, needsAggressiveCompaction: false }
		: hardLimitEmergencyPrune(sourceMessages, input.promptContextWindow, input.emergencyPruneLatch);
	const marked = markOpenAiRemoteReplayBoundary(emergency.messages, {
		model: input.ctx.model,
		branchEntries: input.ctx.sessionManager.getBranch(),
	});
	return repairOrphanedToolResults(convertToLlm(marked));
}
