import type { TokenUsageSnapshot } from "./types.ts";
import { isRecord } from "./types.ts";

const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;

export function emptyUsage(): TokenUsageSnapshot {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

export function collectAssistantUsage(messages: unknown[]): TokenUsageSnapshot {
	const usage = emptyUsage();
	for (const message of messages) addAssistantMessageUsage(usage, message);
	return usage;
}

/**
 * Accumulates assistant token usage streamed during the current agent run so
 * goal accounting can checkpoint mid-turn (tool calls, commands, shutdown)
 * without waiting for `agent_end` and without double counting when it fires.
 */
export class TurnUsageTracker {
	private pending = emptyUsage();
	private flushed = emptyUsage();

	reset(): void {
		this.pending = emptyUsage();
		this.flushed = emptyUsage();
	}

	noteMessageEnd(message: unknown): void {
		addAssistantMessageUsage(this.pending, message);
	}

	takePending(): TokenUsageSnapshot {
		const taken = this.pending;
		this.pending = emptyUsage();
		for (const field of USAGE_FIELDS) this.flushed[field] += taken[field];
		return taken;
	}

	/** Drop usage streamed before a new accounting window opened mid-turn. */
	discardPending(): void {
		this.takePending();
	}

	/** Return the run's total usage minus what checkpoints already accounted. */
	takeRemaining(agentRunMessages: unknown[]): TokenUsageSnapshot {
		const collected = collectAssistantUsage(agentRunMessages);
		const remaining = emptyUsage();
		for (const field of USAGE_FIELDS) {
			remaining[field] = Math.max(0, collected[field] - this.flushed[field]);
			this.flushed[field] = Math.max(this.flushed[field], collected[field]);
		}
		this.pending = emptyUsage();
		return remaining;
	}
}

function addAssistantMessageUsage(target: TokenUsageSnapshot, message: unknown): void {
	if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) return;
	for (const field of USAGE_FIELDS) {
		const value = message.usage[field];
		if (typeof value === "number" && Number.isFinite(value)) target[field] += value;
	}
}
