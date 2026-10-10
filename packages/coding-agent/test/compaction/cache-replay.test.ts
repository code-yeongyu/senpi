import { describe, expect, it } from "vitest";
import { estimateTotalTokens } from "../../src/core/extensions/builtin/compaction/overflow-retry.ts";
import { cacheWriteTokens, replayContextCache, syntheticCacheSession } from "../support/replay-context-cache.ts";

describe("offline cache cost model", () => {
	it("averages both outgoing request sizes including the fixed prompt prefix", () => {
		const entries = syntheticCacheSession().slice(0, 5);
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const firstRequest = estimateTotalTokens(messages.slice(0, 1)) + 123;
		const secondRequest = estimateTotalTokens(messages.slice(0, 3)) + 123;
		const result = replayContextCache(entries, {
			contextWindow: 1_000_000,
			fixedPrefixTokens: 123,
			feedback: true,
		});
		expect(result.requests).toBe(2);
		expect(result.blockBudgetPercent).toBe(10);
		expect(result.averageOutgoingRequestTokens).toBe(Math.round(((firstRequest + secondRequest) / 2) * 100) / 100);
	});

	it("reports a zero average when the recording contains no requests", () => {
		const result = replayContextCache([], { contextWindow: 1_000_000, fixedPrefixTokens: 123, feedback: false });
		expect(result.averageOutgoingRequestTokens).toBe(0);
	});

	it("charges only the byte suffix after the exact common prefix", () => {
		expect(cacheWriteTokens(undefined, Buffer.from("abcdefgh"))).toBe(2);
		expect(cacheWriteTokens(Buffer.from("abcdefgh"), Buffer.from("abcdefgh"))).toBe(0);
		expect(cacheWriteTokens(Buffer.from("abcdefgh"), Buffer.from("abcdefghijkl"))).toBe(1);
		expect(cacheWriteTokens(Buffer.from("abcdefgh"), Buffer.from("abcdWXYZ1234"))).toBe(2);
	});

	it("models the reported request count and clearable versus eval mix", () => {
		const entries = syntheticCacheSession();
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		expect(messages.filter((message) => message.role === "assistant")).toHaveLength(375);
		expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(288);
		expect(messages.filter((message) => message.role === "toolResult" && message.toolName === "eval")).toHaveLength(
			180,
		);
	});

	it("uses the actual frontier state rather than recorded usage to classify the new cache lineage", () => {
		const entries = syntheticCacheSession().slice(0, 5);
		for (const entry of entries) {
			if (entry.type === "message" && entry.message.role === "assistant") entry.message.usage.input = 600_000;
		}
		const result = replayContextCache(entries, {
			contextWindow: 1_000_000,
			fixedPrefixTokens: 0,
			feedback: false,
		});
		expect(result.requests).toBe(2);
		expect(result.peakUnreducedContextTokens).toBeLessThan(500_000);
		expect(result.shapeChanges).toBe(0);
	});
});
