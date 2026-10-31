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

/**
 * Marks the last assistant message before each cut: everything up to it is the reduced prefix, which
 * stays byte-identical until the next frontier step, so a provider with explicit cache breakpoints
 * keeps that prefix cached. A step marks the old cut (read) and the new cut (written for the next
 * step), and both stay marked until the following step so the request bytes do not change between
 * steps (senpi#3242). Copies, never mutates, the messages it marks.
 */
function withStablePrefixCheckpoints(messages: AgentMessage[], state: ContextReductionState): AgentMessage[] {
	let marked: AgentMessage[] | undefined;
	const cuts = state.checkpointCut === undefined ? [state.cutIndex] : [state.checkpointCut, state.cutIndex];
	for (const cut of cuts) {
		for (let index = Math.min(cut, messages.length) - 1; index >= 0; index--) {
			const message = (marked ?? messages)[index];
			if (message.role !== "assistant") continue;
			marked ??= [...messages];
			marked[index] = { ...message, promptCacheBreakpoint: true };
			break;
		}
	}
	return marked ?? messages;
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
		delete state.checkpointCut;
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
			clearToolResults: BUILTIN_CONTEXT_REDUCTION_OPTIONS.clearToolResults && {
				...BUILTIN_CONTEXT_REDUCTION_OPTIONS.clearToolResults,
				keepRecent: 0,
			},
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
	if (state.compactionRequired) return withStablePrefixCheckpoints(reduced, state);
	const tailTokens = estimateTotalTokens(input.unreducedMessages.slice(state.cutIndex));
	if (wasEngaged && !ceilingPressure && tailTokens <= input.contextWindow * (input.blockBudgetRatio ?? 0.1)) {
		return withStablePrefixCheckpoints(reduced, state);
	}

	// Take the whole available block, stopping before the protected recent tail.
	let cut = Math.max(0, messages.length - 5);
	let recentTokens = 0;
	for (let index = messages.length - 1; index >= 0 && recentTokens < 3_000; index--) {
		recentTokens += estimateTotalTokens([input.unreducedMessages[index]]);
		cut = Math.min(cut, index);
	}
	if (cut <= state.cutIndex) {
		if (!wasEngaged) state.engaged = false;
		else if (ceilingPressure) state.compactionRequired = true;
		return withStablePrefixCheckpoints(reduced, state);
	}
	if (
		ceilingPressure &&
		estimateTotalTokens(input.unreducedMessages.slice(state.cutIndex, cut)) < input.contextWindow * 0.1
	) {
		if (!wasEngaged) state.engaged = false;
		else state.compactionRequired = true;
		return withStablePrefixCheckpoints(reduced, state);
	}
	const candidate = reducePrefix(cut);
	const savings = estimateTotalTokens(reduced) - estimateTotalTokens(candidate);
	// Only the OLD lineage supplied the usage bound. Subtract estimated savings
	// conservatively; dropping the bound here would manufacture apparent gains.
	const candidateProjected = Math.max(estimateTotalTokens(candidate) + input.overheadTokens, projected - savings);
	if (savings < input.contextWindow * 0.02 || (ceilingPressure && candidateProjected > input.ceilingTokens * 0.85)) {
		if (ceilingPressure) state.compactionRequired = true;
		return withStablePrefixCheckpoints(reduced, state);
	}
	if (state.cutIndex > 0) state.checkpointCut = state.cutIndex;
	else delete state.checkpointCut;
	state.cutIndex = cut;
	state.prefixHash = fingerprint(cut);
	clearReductionAnchor(state);
	return withStablePrefixCheckpoints(candidate, state);
}
