import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ContextUsage, ExtensionContext, MessageEndEvent, SessionBeforeCompactEvent } from "../../types.ts";
import * as checkpointState from "./checkpoint-state.ts";
import type { SpeculativeCompactionResult, SpeculativeCompactionSnapshot } from "./speculative.ts";

const IMAGE_PROMPT_TOKEN_ESTIMATE = 1_200;
const MAX_OUTPUT_RESERVE_RATIO = 0.5;

function approxTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

export function estimatePendingPromptTokens(event: { prompt?: string; images?: readonly unknown[] }): number {
	return approxTokens(event.prompt ?? "") + (event.images?.length ?? 0) * IMAGE_PROMPT_TOKEN_ESTIMATE;
}

export function getPromptContextWindow(contextWindow: number, maxTokens: number | undefined): number {
	if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0 || contextWindow <= 0) {
		return contextWindow;
	}
	const outputReserve = Math.min(maxTokens, Math.floor(contextWindow * MAX_OUTPUT_RESERVE_RATIO));
	return contextWindow - outputReserve;
}

export function withAdditionalTokens(usage: ContextUsage, additionalTokens: number): ContextUsage {
	if (usage.tokens === null || additionalTokens <= 0) return usage;
	const tokens = usage.tokens + additionalTokens;
	return {
		...usage,
		tokens,
		percent: usage.contextWindow > 0 ? (tokens / usage.contextWindow) * 100 : usage.percent,
	};
}

export function isMonitorableMessageEvent(event: MessageEndEvent): event is MessageEndEvent & {
	message: AgentMessage & { content: Array<{ type: string; text?: string }> };
} {
	return "content" in event.message && Array.isArray(event.message.content);
}

export function isAbortedAssistantMessage(event: { message: AgentMessage }): boolean {
	return event.message.role === "assistant" && "stopReason" in event.message && event.message.stopReason === "aborted";
}

export function isRequiredCompactionFallbackReason(reason: SessionBeforeCompactEvent["reason"]): boolean {
	return reason === "manual" || reason === "threshold" || reason === "overflow";
}

export function recentCheckpoint(ctx: ExtensionContext): checkpointState.AgentCheckpoint | null {
	const checkpoint = checkpointState.getLatestCheckpoint(ctx);
	if (!checkpoint?.timestamp) return null;
	return Date.now() - checkpoint.timestamp <= 60_000 ? checkpoint : null;
}

function shouldEndFeedback(result: SpeculativeCompactionResult): boolean {
	return !result.applied && result.reason !== "rejected";
}

export function endCompactionFeedback(
	ctx: ExtensionContext,
	signal: AbortSignal | undefined,
	result: SpeculativeCompactionResult,
	remoteFallbackReason?: string,
): void {
	if (shouldEndFeedback(result)) {
		// Surface the concrete failure instead of the generic "Compaction did not
		// apply": the remote stage's reason (e.g. remote-compaction-timeout) and the
		// terminal local reason (unavailable / stale), so the decision log and TUI
		// show what actually happened. An aborted compaction renders "Compaction
		// cancelled" downstream and must not carry a failure message.
		const localReason = result.applied ? undefined : result.reason;
		const parts = [remoteFallbackReason, localReason].filter((part): part is string => Boolean(part));
		const errorMessage =
			signal?.aborted || parts.length === 0
				? undefined
				: `Compaction did not apply: ${parts.join("; local fallback ")}`;
		ctx.endCompaction?.({ reason: "extension", signal, aborted: signal?.aborted, errorMessage });
	}
}

export function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
	if (!source) return () => {};
	if (source.aborted) {
		target.abort();
		return () => {};
	}
	const abort = () => target.abort();
	source.addEventListener("abort", abort, { once: true });
	return () => source.removeEventListener("abort", abort);
}

export function createBlockingRemoteCompactionEvent(
	ctx: ExtensionContext,
	snapshot: SpeculativeCompactionSnapshot,
	customInstructions: string,
	signal: AbortSignal,
): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		reason: "extension",
		willRetry: false,
		requestId: randomUUID(),
		preparation: snapshot.preparation,
		branchEntries: ctx.sessionManager.getBranch(),
		customInstructions,
		signal,
	};
}
