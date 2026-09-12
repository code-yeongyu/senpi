import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSessionInfo } from "../src/core/session-discovery.ts";
import {
	clearSessionSummaryCache,
	readCachedSessionSummary,
	sessionSummaryCacheSize,
} from "../src/core/session-summary-cache.ts";

const SESSION_ID = "exactness-session" as const;
const HEADER_TIMESTAMP = "2026-03-01T00:00:00.000Z" as const;
/** Wide enough that a middle record sits far past any fixed-size head window. */
const PADDING = "exactness-filler-padding".repeat(40);
const TURNS_PER_SIDE = 400 as const;

function headerLine(cwd: string, extra: Readonly<Record<string, unknown>> = {}): string {
	return JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: HEADER_TIMESTAMP, cwd, ...extra });
}

function messageLine(index: number, content: string, role: "user" | "assistant", timeMs: number): string {
	return JSON.stringify({
		type: "message",
		id: `msg-${index}`,
		parentId: index === 1 ? null : `msg-${index - 1}`,
		timestamp: new Date(timeMs).toISOString(),
		message: { role, content, timestamp: timeMs },
	});
}

function filler(index: number, timeMs: number): string {
	return messageLine(index, `filler-${index} ${PADDING}`, index % 2 === 0 ? "assistant" : "user", timeMs);
}

describe("session summary exactness", () => {
	let tempDir: string;
	let projectDir: string;
	let file: string;

	beforeEach(() => {
		clearSessionSummaryCache();
		tempDir = mkdtempSync(join(tmpdir(), "session-summary-exact-"));
		projectDir = join(tempDir, "project");
		mkdirSync(projectDir, { recursive: true });
		file = join(tempDir, `${SESSION_ID}.jsonl`);
	});

	afterEach(() => {
		clearSessionSummaryCache();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("takes the first user message from the middle when earlier records are assistant-only", async () => {
		// Given: a session whose first *user* message sits deep past every assistant record.
		const base = Date.parse(HEADER_TIMESTAMP);
		const lines = [headerLine(projectDir)];
		let index = 0;
		for (let turn = 0; turn < TURNS_PER_SIDE; turn++) {
			lines.push(messageLine(++index, `assistant-only-${turn} ${PADDING}`, "assistant", base + index));
		}
		lines.push(messageLine(++index, "the-real-first-user-message", "user", base + index));
		for (let turn = 0; turn < TURNS_PER_SIDE; turn++) {
			lines.push(messageLine(++index, `tail-user-${turn} ${PADDING}`, "user", base + index));
		}
		writeFileSync(file, `${lines.join("\n")}\n`);

		// When: the picker row is built.
		const info = await buildSessionInfo(file);

		// Then: the mid-file user message is the row's first message.
		expect(info?.firstMessage).toBe("the-real-first-user-message");
	});

	it("takes the latest session_info name from the middle of the file", async () => {
		// Given: renames early and mid-file, with a long transcript tail after the last one.
		const base = Date.parse(HEADER_TIMESTAMP);
		const lines = [
			headerLine(projectDir),
			JSON.stringify({ type: "session_info", id: "info-1", timestamp: HEADER_TIMESTAMP, name: "early-name" }),
		];
		let index = 0;
		for (let turn = 0; turn < TURNS_PER_SIDE; turn++) {
			lines.push(filler(++index, base + index));
		}
		lines.push(
			JSON.stringify({ type: "session_info", id: "info-2", timestamp: HEADER_TIMESTAMP, name: "middle-name" }),
		);
		for (let turn = 0; turn < TURNS_PER_SIDE; turn++) {
			lines.push(filler(++index, base + index));
		}
		writeFileSync(file, `${lines.join("\n")}\n`);

		// When: the picker row is built.
		const info = await buildSessionInfo(file);

		// Then: the mid-file rename wins over the early one.
		expect(info?.name).toBe("middle-name");
	});

	it("takes the max activity time when the newest message is not the last record", async () => {
		// Given: the newest timestamp mid-file, followed by older records.
		const base = Date.parse(HEADER_TIMESTAMP);
		const newest = base + 900_000;
		const lines = [
			headerLine(projectDir),
			messageLine(1, "first", "user", base + 1_000),
			messageLine(2, "newest-mid-file", "assistant", newest),
			messageLine(3, "older-after-newest", "user", base + 2_000),
			messageLine(4, "older-still", "assistant", base + 3_000),
		];
		writeFileSync(file, `${lines.join("\n")}\n`);

		// When: the picker row is built.
		const info = await buildSessionInfo(file);

		// Then: modified reflects the max activity time, not the last record's.
		expect(info?.modified.getTime()).toBe(newest);
	});

	it("counts message records regardless of whitespace and property order", async () => {
		// Given: message records written with reordered keys and padded whitespace.
		const base = Date.parse(HEADER_TIMESTAMP);
		const lines = [
			headerLine(projectDir),
			'  {"message":{"role":"user","content":"reordered-one","timestamp":1},"timestamp":"2026-03-01T00:00:01.000Z","id":"msg-1","parentId":null,"type":"message"}  ',
			`{ "type" : "message" , "id" : "msg-2" , "parentId" : "msg-1" , "timestamp" : "${new Date(base + 2).toISOString()}" , "message" : { "role" : "assistant" , "content" : "spaced-two" } }`,
			"",
			"   ",
			messageLine(3, "plain-three", "user", base + 3),
		];
		writeFileSync(file, `${lines.join("\n")}\n`);

		// When: the picker row is built.
		const info = await buildSessionInfo(file);

		// Then: all three message records count, and their text is searchable.
		expect(info?.messageCount).toBe(3);
		expect(info?.allMessagesText).toBe("reordered-one spaced-two plain-three");
	});

	it("keeps intact records when the final JSONL record is truncated", async () => {
		// Given: valid records followed by a truncated trailing record.
		const base = Date.parse(HEADER_TIMESTAMP);
		const valid = [
			headerLine(projectDir),
			messageLine(1, "kept-one", "user", base + 1),
			messageLine(2, "kept-two", "assistant", base + 2),
		];
		const truncated = '{"type":"message","id":"msg-3","parentId":"msg-2","message":{"role":"user","content":"partial';
		writeFileSync(file, `${valid.join("\n")}\n${truncated}\n`);

		// When: the picker row is built.
		const info = await buildSessionInfo(file);

		// Then: the intact records survive and the truncated tail is dropped.
		expect(info?.messageCount).toBe(2);
		expect(info?.allMessagesText).toBe("kept-one kept-two");
	});

	it("rejects a file whose first record is not a session header", async () => {
		// Given: a JSONL file that starts with a non-session record.
		writeFileSync(file, `${JSON.stringify({ type: "event", id: "not-a-session" })}\n`);

		// When: the picker row is built.
		const info = await buildSessionInfo(file);

		// Then: no row is produced and nothing is cached for it.
		expect(info).toBeNull();
		expect(sessionSummaryCacheSize()).toBe(0);
	});

	it("drops the cache entry when the file becomes unreadable", async () => {
		// Given: a cached summary for an existing session file.
		writeFileSync(
			file,
			`${headerLine(projectDir)}\n${messageLine(1, "only", "user", Date.parse(HEADER_TIMESTAMP))}\n`,
		);
		expect(await readCachedSessionSummary(file)).not.toBeNull();

		// When: the file is removed and the summary is requested again.
		rmSync(file);
		const afterRemoval = await readCachedSessionSummary(file);

		// Then: the stale entry is gone rather than served from cache.
		expect(afterRemoval).toBeNull();
		expect(sessionSummaryCacheSize()).toBe(0);
	});

	it("preserves the parent session path from the header", async () => {
		// Given: a forked session header carrying a parent path.
		const parentPath = join(tempDir, "parent.jsonl");
		writeFileSync(
			file,
			`${headerLine(projectDir, { parentSession: parentPath })}\n${messageLine(1, "forked", "user", Date.parse(HEADER_TIMESTAMP))}\n`,
		);

		// When: the picker row is built.
		const info = await buildSessionInfo(file);

		// Then: the row carries the header's parent path and cwd.
		expect(info?.parentSessionPath).toBe(parentPath);
		expect(info?.cwd).toBe(projectDir);
	});
});
