import { describe, expect, it } from "vitest";
import { estimateTotalTokens } from "../../src/core/extensions/builtin/compaction/overflow-retry.ts";
import type { FileEntry } from "../../src/core/session-manager.ts";
import { syntheticCacheSession } from "../support/cache-replay-fixture.ts";
import { cacheWriteTokens, replayContextCache } from "../support/cache-replay-model.ts";

describe("offline cache cost model", () => {
	it.each([true, false])("uses recorded ceiling anchors only when their cut matches: %s", (matches) => {
		const entries = syntheticCacheSession().slice(0, 5);
		const response = entries.at(-1);
		if (response?.type !== "message") throw new Error("Missing response fixture");
		const saved: FileEntry = {
			type: "custom",
			id: "anchor",
			parentId: response.parentId,
			timestamp: response.timestamp,
			customType: "senpi.context-reduction.v1",
			data: {
				engaged: false,
				cutIndex: 0,
				prefixHash: "",
				anchorCount: 1,
				anchorCut: matches ? 0 : 1,
				anchorHash: "",
				anchorTokens: 99_000,
			},
		};
		response.parentId = saved.id;
		entries.splice(entries.length - 1, 0, saved);
		const result = replayContextCache(entries, { contextWindow: 100_000, fixedPrefixTokens: 0, feedback: false });
		expect(result.recordedUsageAnchors).toBe(matches ? 1 : 0);
		expect(result.compactionRequiredRequests).toBe(matches ? 1 : 0);
	});

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
