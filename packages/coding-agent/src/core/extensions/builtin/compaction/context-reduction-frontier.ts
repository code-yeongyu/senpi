import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	BUILTIN_CONTEXT_REDUCTION_OPTIONS,
	reduceContextMessages,
	shouldApplyContextReduction,
} from "./context-reduction.ts";
import {
	type ContextReductionState,
	clearReductionAnchor,
	createContextReductionState,
} from "./context-reduction-state.ts";
import { estimateTotalTokens } from "./overflow-retry.ts";

export function projectedReductionTokens(
	messages: AgentMessage[],
	state: ContextReductionState,
	unreducedMessages: AgentMessage[],
	overheadTokens: number,
): number {
	const estimate = estimateTotalTokens(messages) + overheadTokens;
	if (
		state.anchorCount === undefined ||
		state.anchorTokens === undefined ||
		state.anchorCount > unreducedMessages.length ||
		state.anchorCut !== state.cutIndex ||
		state.anchorHash !== state.prefixHash
	)
		return estimate;
	return Math.max(estimate, state.anchorTokens + estimateTotalTokens(unreducedMessages.slice(state.anchorCount)));
}

/** Reduce an immutable prefix; a ceiling step must buy an entire hysteresis band. */
export function reduceContextWithFrontier(
	messages: AgentMessage[],
	state: ContextReductionState,
	input: {
		unreducedMessages: AgentMessage[];
		contextWindow: number;
		ceilingTokens: number;
		overheadTokens: number;
		blockBudgetRatio?: number;
		force: boolean;
	},
): AgentMessage[] {
	const fingerprint = (cut: number) =>
		createHash("sha256")
			.update(JSON.stringify(input.unreducedMessages.slice(0, cut)))
			.digest("hex");
	if (state.cutIndex > messages.length || (state.cutIndex > 0 && fingerprint(state.cutIndex) !== state.prefixHash)) {
		Object.assign(state, createContextReductionState());
		clearReductionAnchor(state);
		delete state.compactionRequired;
	}
	const reducePrefix = (cut: number) => [
		...reduceContextMessages(messages.slice(0, cut), {
			collapse: BUILTIN_CONTEXT_REDUCTION_OPTIONS.collapse && {
				...BUILTIN_CONTEXT_REDUCTION_OPTIONS.collapse,
				protectRecentMessages: 0,
			},
			shrinkAssistant: BUILTIN_CONTEXT_REDUCTION_OPTIONS.shrinkAssistant && {
				...BUILTIN_CONTEXT_REDUCTION_OPTIONS.shrinkAssistant,
				protectRecentTokens: 0,
			},
			clearToolResults: BUILTIN_CONTEXT_REDUCTION_OPTIONS.clearToolResults,
		}).messages,
		...messages.slice(cut),
	];
	const reduced = state.engaged ? reducePrefix(state.cutIndex) : messages;
	const projected = projectedReductionTokens(reduced, state, input.unreducedMessages, input.overheadTokens);
	const ceilingPressure = projected >= Math.max(0, input.ceilingTokens * 0.95);
	const wasEngaged = state.engaged;
	if (
		!state.engaged &&
		!input.force &&
		!ceilingPressure &&
		!shouldApplyContextReduction({
			usageTokens: estimateTotalTokens(input.unreducedMessages) + input.overheadTokens,
			contextWindow: input.contextWindow,
		})
	)
		return messages;
	state.engaged = true;
	if (state.compactionRequired) return reduced;
	const tailTokens = estimateTotalTokens(input.unreducedMessages.slice(state.cutIndex));
	if (wasEngaged && !ceilingPressure && tailTokens <= input.contextWindow * (input.blockBudgetRatio ?? 0.1)) {
		return reduced;
	}

	// Take the whole available block, stopping before the protected recent tail.
	let cut = Math.max(0, messages.length - 5);
	let recentTokens = 0;
	for (let index = messages.length - 1; index >= 0 && recentTokens < 3_000; index--) {
		recentTokens += estimateTotalTokens([input.unreducedMessages[index]]);
		cut = Math.min(cut, index);
	}
	if (cut <= state.cutIndex) {
		if (ceilingPressure) state.compactionRequired = true;
		return reduced;
	}
	if (
		ceilingPressure &&
		estimateTotalTokens(input.unreducedMessages.slice(state.cutIndex, cut)) < input.contextWindow * 0.1
	) {
		state.compactionRequired = true;
		return reduced;
	}
	const candidate = reducePrefix(cut);
	const savings = estimateTotalTokens(reduced) - estimateTotalTokens(candidate);
	// Only the OLD lineage supplied the usage bound. Subtract estimated savings
	// conservatively; dropping the bound here would manufacture apparent gains.
	const candidateProjected = Math.max(estimateTotalTokens(candidate) + input.overheadTokens, projected - savings);
	if (savings < input.contextWindow * 0.02 || (ceilingPressure && candidateProjected > input.ceilingTokens * 0.85)) {
		if (ceilingPressure) state.compactionRequired = true;
		return reduced;
	}
	state.cutIndex = cut;
	state.prefixHash = fingerprint(cut);
	clearReductionAnchor(state);
	return candidate;
}
