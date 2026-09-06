import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateTotalTokens, pruneOldMessagesToBudget, SUMMARIZATION_INPUT_BUDGET_RATIO } from "./overflow-retry.ts";
import * as truncation from "./tool-truncation.ts";

const EMERGENCY_CONTEXT_TARGET_RATIO = 0.95;
const EMERGENCY_CONTEXT_RELEASE_RATIO = 0.85;
export function pruneToolResults(messages: AgentMessage[], contextWindow: number, budgetRatio: number): AgentMessage[] {
	const toolResults = messages
		.filter((message) => message.role === "toolResult")
		.map((message) => ({ content: message.content, details: undefined }));
	if (toolResults.length === 0) return messages;

	const prunedResults = truncation.prePruneToolOutputsToBudget(toolResults, contextWindow * budgetRatio);
	let resultIndex = 0;
	return messages.map((message) => {
		if (message.role !== "toolResult") return message;
		const pruned = prunedResults[resultIndex];
		resultIndex++;
		return pruned ? { ...message, content: pruned.content } : message;
	});
}

export function truncateContextMessages(messages: AgentMessage[]): AgentMessage[] {
	const toolResults = messages
		.filter((message) => message.role === "toolResult")
		.map((message) => ({ content: message.content, details: undefined }));
	if (toolResults.length === 0) return messages;

	const truncatedResults = truncation.truncateOversizedToolResults(toolResults);
	let resultIndex = 0;
	return messages.map((message) => {
		if (message.role !== "toolResult") return message;
		const truncated = truncatedResults[resultIndex];
		resultIndex++;
		return truncated ? { ...message, content: truncated.content } : message;
	});
}

/**
 * Sticky engage/release state for {@link hardLimitEmergencyPrune}. Callers that
 * issue many requests for one session share a single latch so the emitted context
 * shape stays stable while the estimate hovers around the engage threshold.
 */

export interface EmergencyPruneLatch {
	engaged: boolean;
}

export function createEmergencyPruneLatch(): EmergencyPruneLatch {
	return { engaged: false };
}

export function hardLimitEmergencyPrune(
	messages: AgentMessage[],
	contextWindow: number,
	latch?: EmergencyPruneLatch,
): {
	messages: AgentMessage[];
	needsAggressiveCompaction: boolean;
} {
	const targetTokens = Math.floor(contextWindow * EMERGENCY_CONTEXT_TARGET_RATIO);
	const releaseTokens = Math.floor(contextWindow * EMERGENCY_CONTEXT_RELEASE_RATIO);
	const totalTokens = estimateTotalTokens(messages);
	// Without a latch this keeps the historical single-threshold behaviour.
	const engaged = latch
		? latch.engaged
			? totalTokens > releaseTokens
			: totalTokens > targetTokens
		: totalTokens > targetTokens;
	if (latch) latch.engaged = engaged;
	if (!engaged) {
		return { messages, needsAggressiveCompaction: false };
	}
	const noLlmPruned = truncateContextMessages(
		pruneToolResults(messages, contextWindow, SUMMARIZATION_INPUT_BUDGET_RATIO),
	);
	if (estimateTotalTokens(noLlmPruned) <= targetTokens) {
		return { messages: noLlmPruned, needsAggressiveCompaction: false };
	}
	return {
		messages: pruneOldMessagesToBudget(noLlmPruned, targetTokens),
		needsAggressiveCompaction: true,
	};
}
