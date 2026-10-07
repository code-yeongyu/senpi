import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSessionSummaryCache, readCachedSessionSummary } from "../src/core/session-summary-cache.ts";
import { SESSION_SUMMARY_INDEX_FILE, SessionSummaryIndex } from "../src/core/session-summary-index.ts";

// senpi#2087: the on-disk summary index is bounded like the in-memory cache.

const TEXT_BYTES = 2000 as const;

function writeSession(dir: string, id: string, activityMs: number): string {
	const path = join(dir, `${id}.jsonl`);
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-06-01T00:00:00.000Z", cwd: dir }),
		JSON.stringify({
			type: "message",
			id: `${id}-msg`,
			parentId: null,
			timestamp: new Date(activityMs).toISOString(),
			message: { role: "user", content: `${id} ${"x".repeat(TEXT_BYTES)}`, timestamp: activityMs },
		}),
	];
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

function indexedIds(dir: string): string[] {
	const [header, ...entries] = readFileSync(join(dir, SESSION_SUMMARY_INDEX_FILE), "utf8").trimEnd().split("\n");
	expect(JSON.parse(header ?? "")).toEqual({ version: 2 });
	return entries.map((line) => (JSON.parse(line) as { summary: { header: { id: string } } }).summary.header.id).sort();
}

describe("session summary index byte budget", () => {
	let dir: string;

	beforeEach(() => {
		clearSessionSummaryCache();
		dir = mkdtempSync(join(tmpdir(), "session-summary-index-budget-"));
	});

	afterEach(() => {
		clearSessionSummaryCache();
		rmSync(dir, { recursive: true, force: true });
	});

	async function listThroughIndex(files: readonly string[], maxBytes: number): Promise<void> {
		const index = new SessionSummaryIndex(dir, { maxBytes });
		for (const file of files) expect(await readCachedSessionSummary(file, index)).not.toBeNull();
		await index.persist(files);
	}

	it("evicts the least recently active sessions until the index fits its budget", async () => {
		// Given: three sessions with distinct activity times and a budget that holds two entries.
		const files = [
			writeSession(dir, "oldest", Date.parse("2026-06-01T00:00:00.000Z")),
			writeSession(dir, "middle", Date.parse("2026-06-02T00:00:00.000Z")),
			writeSession(dir, "newest", Date.parse("2026-06-03T00:00:00.000Z")),
		];

		// When: the sessions are listed through an index capped at two and a half entries.
		await listThroughIndex(files, TEXT_BYTES * 2 * 2.5 + 1000);

		// Then: the two most recently active sessions are indexed and the oldest is not.
		expect(indexedIds(dir)).toEqual(["middle", "newest"]);
	});

	it("does not rewrite the index when nothing changed", async () => {
		// Given: an index already written for two sessions.
		const files = [
			writeSession(dir, "one", Date.parse("2026-06-01T00:00:00.000Z")),
			writeSession(dir, "two", Date.parse("2026-06-02T00:00:00.000Z")),
		];
		await listThroughIndex(files, 1024 * 1024);
		const indexPath = join(dir, SESSION_SUMMARY_INDEX_FILE);
		const before = statSync(indexPath);

		// When: a fresh process lists the same unchanged sessions.
		clearSessionSummaryCache();
		await listThroughIndex(files, 1024 * 1024);

		// Then: the index file is untouched.
		const after = statSync(indexPath);
		expect(after.size).toBe(before.size);
		expect(after.ino).toBe(before.ino);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});
});
