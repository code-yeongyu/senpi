import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	BUILTIN_CONTEXT_REDUCTION_OPTIONS,
	type ContextReductionLatch,
	createContextReductionLatch,
	reduceContextMessages,
	resetContextReductionLatch,
	shouldApplyContextReduction,
} from "../../../src/core/extensions/builtin/compaction/context-reduction.ts";

const CONTEXT_WINDOW = 1_000_000;
const EXPOSURE_REQUESTS = 507;
const OBSERVED_THRESHOLD_CROSSINGS = 319;

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantToolCall(id: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: { command: `probe-${id}` } }],
		api: "faux-completion",
		provider: "faux",
		model: "faux-model",
		usage: emptyUsage(),
		stopReason: "toolUse",
		timestamp,
	};
}

function toolResult(id: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text", text: `result-${id}-${"x".repeat(4_000)}` }],
		isError: false,
		timestamp,
	};
}

function userMessage(text: string, timestamp: number): UserMessage {
	return { role: "user", content: text, timestamp };
}

function thresholdControlHistory(): AgentMessage[] {
	const messages: AgentMessage[] = [userMessage("sanitized threshold-control fixture", 1)];
	for (let index = 0; index < 12; index += 1) {
		const id = `call-${index}`;
		messages.push(assistantToolCall(id, index * 2 + 2), toolResult(id, index * 2 + 3));
	}
	messages.push(userMessage("latest request", 100));
	return messages;
}

function payloadHash(messages: AgentMessage[]): string {
	return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

describe("request-local context reduction cache stability", () => {
	it("keeps one payload shape across the 507-request threshold-control fixture", () => {
		// Given: the incident had a one-million-token window, 507 proxy-exposed
		// requests, and 319 observed threshold crossings. This intentionally small
		// control fixture isolates state-machine oscillation without claiming to
		// reproduce payload scale or that the proxy cohort measures caused overhead.
		// Payload-scale reducer behavior is pinned by the companion lifecycle test.
		const messages = thresholdControlHistory();
		const latch = { engaged: false } satisfies ContextReductionLatch;
		const usageSeries = Array.from({ length: EXPOSURE_REQUESTS }, (_, index) => {
			if (index > OBSERVED_THRESHOLD_CROSSINGS) return 499_000;
			return index % 2 === 0 ? 501_000 : 499_000;
		});

		// When: every provider request independently assembles context from the
		// same stored history while computed usage crosses the 50% gate.
		const hashes = usageSeries.map((usageTokens) => {
			const shouldReduce = shouldApplyContextReduction({ usageTokens, contextWindow: CONTEXT_WINDOW }, latch);
			const outgoing = shouldReduce
				? reduceContextMessages(messages, BUILTIN_CONTEXT_REDUCTION_OPTIONS).messages
				: messages;
			return payloadHash(outgoing);
		});

		// Then: once reduction engages, request-local payloads retain one stable
		// cacheable shape until persisted compaction resets the latch.
		expect(new Set(hashes).size).toBe(1);
		expect(hashes.every((hash) => hash !== payloadHash(messages))).toBe(true);
	});

	it("resets the sticky reduction state after accepted persisted compaction", () => {
		const latch = createContextReductionLatch();

		expect(shouldApplyContextReduction({ usageTokens: 501_000, contextWindow: CONTEXT_WINDOW }, latch)).toBe(true);
		expect(shouldApplyContextReduction({ usageTokens: 499_000, contextWindow: CONTEXT_WINDOW }, latch)).toBe(true);

		resetContextReductionLatch(latch);

		expect(shouldApplyContextReduction({ usageTokens: 499_000, contextWindow: CONTEXT_WINDOW }, latch)).toBe(false);
	});

	it("preserves the provider-native compaction bypass while sticky", () => {
		const latch = { engaged: true } satisfies ContextReductionLatch;
		const shouldReduce = shouldApplyContextReduction(
			{
				usageTokens: 900_000,
				contextWindow: CONTEXT_WINDOW,
				isProviderNativeCompactionPath: true,
			},
			latch,
		);
		expect(shouldReduce).toBe(false);
		expect(latch.engaged).toBe(true);
	});
});
