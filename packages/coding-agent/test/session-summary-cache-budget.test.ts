import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionHeader } from "../src/core/session-manager.ts";
import type { SessionSummary } from "../src/core/session-summary.ts";
import {
	clearSessionSummaryCache,
	readCachedSessionSummary,
	sessionSummaryCacheSize,
	sessionSummaryCacheTextBytes,
} from "../src/core/session-summary-cache.ts";
import { SessionSummaryLru, type SummaryEntry } from "../src/core/session-summary-lru.ts";

const HEADER_TIMESTAMP = "2026-04-01T00:00:00.000Z" as const;
/** Small enough that a handful of synthetic summaries cross it. */
const TINY_TEXT_BUDGET = 100 as const;

function header(id: string): SessionHeader {
	return { type: "session", version: 3, id, timestamp: HEADER_TIMESTAMP, cwd: "/tmp/project" };
}

function entryWithText(id: string, text: string): SummaryEntry {
	const summary: SessionSummary = {
		header: header(id),
		name: undefined,
		firstUserMessage: text,
		messageCount: 1,
		lastActivityTime: Date.parse(HEADER_TIMESTAMP),
		allMessagesText: text,
	};
	return { stamp: { size: text.length, mtimeMs: 1 }, summary, mtime: new Date(HEADER_TIMESTAMP) };
}

describe("session summary cache byte budget", () => {
	describe("SessionSummaryLru", () => {
		it("evicts least-recently-used entries until retained bytes fit the budget", () => {
			// Given: an LRU whose byte budget holds two 40-byte summaries but not three.
			const lru = new SessionSummaryLru({ maxEntries: 1000, maxTextBytes: TINY_TEXT_BUDGET });
			lru.retain("a", entryWithText("a", "a".repeat(40)));
			lru.retain("b", entryWithText("b", "b".repeat(40)));

			// When: a third summary pushes retained bytes past the budget.
			lru.retain("c", entryWithText("c", "c".repeat(40)));

			// Then: the oldest entry is gone and retained bytes are back under the ceiling.
			expect(lru.get("a")).toBeUndefined();
			expect(lru.get("b")?.summary.header.id).toBe("b");
			expect(lru.get("c")?.summary.header.id).toBe("c");
			expect(lru.size).toBe(2);
			expect(lru.textBytes).toBe(80);
			expect(lru.textBytes).toBeLessThanOrEqual(TINY_TEXT_BUDGET);
		});

		it("evicts by recency of use rather than of insertion", () => {
			// Given: three retained summaries where the oldest insert was read most recently.
			const lru = new SessionSummaryLru({ maxEntries: 1000, maxTextBytes: TINY_TEXT_BUDGET });
			lru.retain("a", entryWithText("a", "a".repeat(40)));
			lru.retain("b", entryWithText("b", "b".repeat(40)));
			lru.get("a");

			// When: a third summary forces an eviction.
			lru.retain("c", entryWithText("c", "c".repeat(40)));

			// Then: the entry not read since insertion is the one evicted.
			expect(lru.get("b")).toBeUndefined();
			expect(lru.get("a")?.summary.header.id).toBe("a");
		});

		it("counts UTF-8 bytes rather than code units", () => {
			// Given: a budget of 100 bytes and a 60-character summary of 3-byte characters.
			const lru = new SessionSummaryLru({ maxEntries: 1000, maxTextBytes: TINY_TEXT_BUDGET });
			const multiByte = "한".repeat(60);
			expect(multiByte.length).toBeLessThan(TINY_TEXT_BUDGET);

			// When: that summary is retained.
			lru.retain("wide", entryWithText("wide", multiByte));

			// Then: its 180 bytes exceed the budget, so it is not retained at all.
			expect(lru.size).toBe(0);
			expect(lru.textBytes).toBe(0);
		});

		it("keeps existing entries when an oversized summary is refused", () => {
			// Given: an LRU already holding a small summary.
			const lru = new SessionSummaryLru({ maxEntries: 1000, maxTextBytes: TINY_TEXT_BUDGET });
			lru.retain("small", entryWithText("small", "s".repeat(40)));

			// When: a summary larger than the whole budget is offered.
			lru.retain("huge", entryWithText("huge", "h".repeat(TINY_TEXT_BUDGET * 3)));

			// Then: the oversized summary is refused and the small one survives untouched.
			expect(lru.get("huge")).toBeUndefined();
			expect(lru.get("small")?.summary.header.id).toBe("small");
			expect(lru.size).toBe(1);
			expect(lru.textBytes).toBe(40);
		});

		it("drops a stale entry when its oversized replacement is refused", () => {
			// Given: a retained summary that a later read finds much larger.
			const lru = new SessionSummaryLru({ maxEntries: 1000, maxTextBytes: TINY_TEXT_BUDGET });
			lru.retain("grown", entryWithText("grown", "old-text"));

			// When: the grown summary exceeds the budget and is refused.
			lru.retain("grown", entryWithText("grown", "g".repeat(TINY_TEXT_BUDGET * 3)));

			// Then: the stale summary is gone rather than served for the changed file.
			expect(lru.get("grown")).toBeUndefined();
			expect(lru.size).toBe(0);
			expect(lru.textBytes).toBe(0);
		});

		it("still enforces the entry ceiling when bytes are plentiful", () => {
			// Given: a two-entry ceiling and an effectively unlimited byte budget.
			const lru = new SessionSummaryLru({ maxEntries: 2, maxTextBytes: 1024 * 1024 });
			lru.retain("a", entryWithText("a", "a"));
			lru.retain("b", entryWithText("b", "b"));

			// When: a third summary is retained.
			lru.retain("c", entryWithText("c", "c"));

			// Then: the entry ceiling evicts the oldest even though bytes were fine.
			expect(lru.size).toBe(2);
			expect(lru.get("a")).toBeUndefined();
		});

		it("returns retained bytes to zero after a clear", () => {
			// Given: an LRU holding two summaries.
			const lru = new SessionSummaryLru({ maxEntries: 1000, maxTextBytes: TINY_TEXT_BUDGET });
			lru.retain("a", entryWithText("a", "a".repeat(20)));
			lru.retain("b", entryWithText("b", "b".repeat(20)));

			// When: the cache is cleared.
			lru.clear();

			// Then: both the entry count and the byte tally reset.
			expect(lru.size).toBe(0);
			expect(lru.textBytes).toBe(0);
		});
	});

	describe("process-local cache", () => {
		let tempDir: string;

		beforeEach(() => {
			clearSessionSummaryCache();
			tempDir = mkdtempSync(join(tmpdir(), "session-summary-budget-"));
			mkdirSync(tempDir, { recursive: true });
		});

		afterEach(() => {
			clearSessionSummaryCache();
			rmSync(tempDir, { recursive: true, force: true });
		});

		function writeSession(id: string, text: string): string {
			const path = join(tempDir, `${id}.jsonl`);
			const lines = [
				JSON.stringify({ type: "session", version: 3, id, timestamp: HEADER_TIMESTAMP, cwd: tempDir }),
				JSON.stringify({
					type: "message",
					id: "msg-1",
					parentId: null,
					timestamp: HEADER_TIMESTAMP,
					message: { role: "user", content: text, timestamp: Date.parse(HEADER_TIMESTAMP) },
				}),
			];
			writeFileSync(path, `${lines.join("\n")}\n`);
			return path;
		}

		it("tracks retained transcript bytes for cached session files", async () => {
			// Given: two session files with known transcript text.
			const first = writeSession("first", "first-transcript-text");
			const second = writeSession("second", "second-transcript-text");

			// When: both are summarized through the process-local cache.
			await readCachedSessionSummary(first);
			await readCachedSessionSummary(second);

			// Then: the byte tally is the sum of the two transcripts.
			expect(sessionSummaryCacheSize()).toBe(2);
			expect(sessionSummaryCacheTextBytes()).toBe(
				Buffer.byteLength("first-transcript-text") + Buffer.byteLength("second-transcript-text"),
			);
		});

		it("does not double-count a repeated read of an unchanged file", async () => {
			// Given: a session file already summarized once.
			const path = writeSession("stable", "stable-transcript-text");
			await readCachedSessionSummary(path);
			const bytesAfterFirstRead = sessionSummaryCacheTextBytes();

			// When: the unchanged file is summarized twice more.
			await readCachedSessionSummary(path);
			await readCachedSessionSummary(path);

			// Then: the byte tally is unchanged, so cache hits do not leak accounting.
			expect(sessionSummaryCacheTextBytes()).toBe(bytesAfterFirstRead);
			expect(sessionSummaryCacheSize()).toBe(1);
		});

		it("releases retained bytes when a cached file becomes unreadable", async () => {
			// Given: a cached summary for an existing session file.
			const path = writeSession("vanishing", "vanishing-transcript-text");
			await readCachedSessionSummary(path);
			expect(sessionSummaryCacheTextBytes()).toBeGreaterThan(0);

			// When: the file is removed and the summary is requested again.
			rmSync(path);
			await readCachedSessionSummary(path);

			// Then: the entry and its bytes are both released.
			expect(sessionSummaryCacheSize()).toBe(0);
			expect(sessionSummaryCacheTextBytes()).toBe(0);
		});
	});
});
