import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.ts";
import { clearSessionSummaryCache } from "../src/core/session-summary-cache.ts";
import { filterAndSortSessions } from "../src/modes/interactive/components/session-selector-search.ts";

const SESSION_ID = "search-text-session" as const;
const MIDDLE_PHRASE = "middle-only-searchable-phrase" as const;
const HEADER_TIMESTAMP = "2026-02-01T00:00:00.000Z" as const;
const MESSAGE_TIMESTAMP = "2026-02-01T00:00:01.000Z" as const;
/** Enough turns that the phrase sits deep in the middle of a multi-window file. */
const TURNS_PER_SIDE = 200 as const;

function userMessageLine(index: number, content: string): string {
	return JSON.stringify({
		type: "message",
		id: `msg-${index}`,
		parentId: index === 1 ? null : `msg-${index - 1}`,
		timestamp: MESSAGE_TIMESTAMP,
		message: { role: "user", content, timestamp: Date.parse(MESSAGE_TIMESTAMP) },
	});
}

/** A session whose only occurrence of MIDDLE_PHRASE sits deep in the middle of the file. */
function writeMiddlePhraseSession(path: string, cwd: string): void {
	const lines = [JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: HEADER_TIMESTAMP, cwd })];
	let index = 0;
	const padding = "filler-padding-text".repeat(6);
	for (let turn = 0; turn < TURNS_PER_SIDE; turn++) {
		lines.push(userMessageLine(++index, `head-side-${turn} ${padding}`));
	}
	lines.push(userMessageLine(++index, MIDDLE_PHRASE));
	for (let turn = 0; turn < TURNS_PER_SIDE; turn++) {
		lines.push(userMessageLine(++index, `tail-side-${turn} ${padding}`));
	}
	writeFileSync(path, `${lines.join("\n")}\n`);
}

describe("session discovery search text", () => {
	let tempDir: string;
	let projectDir: string;
	let sessionDir: string;
	let phraseParseCount: number;

	beforeEach(() => {
		clearSessionSummaryCache();
		tempDir = mkdtempSync(join(tmpdir(), "session-search-text-"));
		projectDir = join(tempDir, "project");
		sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		writeMiddlePhraseSession(join(sessionDir, `${SESSION_ID}.jsonl`), projectDir);
		phraseParseCount = 0;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		clearSessionSummaryCache();
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Count JSON.parse calls that deserialize the middle record from here on. */
	function spyOnPhraseParses(): void {
		const originalParse = JSON.parse;
		vi.spyOn(JSON, "parse").mockImplementation(
			(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown => {
				if (text.includes(MIDDLE_PHRASE)) {
					phraseParseCount += 1;
				}
				return originalParse(text, reviver);
			},
		);
	}

	async function listRows(): Promise<SessionInfo[]> {
		const rows = await SessionManager.list(projectDir, sessionDir);
		expect(rows.map((row) => row.id)).toEqual([SESSION_ID]);
		return rows;
	}

	it("does not re-parse a middle-only record when relisting an unchanged session", async () => {
		// Given: a cold listing that has already summarized the session file.
		await listRows();
		spyOnPhraseParses();

		// When: the same unchanged session directory is listed again.
		await listRows();

		// Then: the cached summary served the row without deserializing the middle record.
		expect(phraseParseCount).toBe(0);
	});

	it("keeps the middle-only phrase searchable on a non-empty query", async () => {
		// Given: listed picker rows for a session whose phrase lives mid-file.
		const rows = await listRows();

		// When: a non-empty query searches the listed rows.
		const matched = filterAndSortSessions(rows, `"${MIDDLE_PHRASE}"`, "recent");

		// Then: the row matches on text that only exists in the middle of the file.
		expect(matched.map((row) => row.id)).toEqual([SESSION_ID]);
	});

	it("keeps the middle-only phrase searchable from a warm cached listing", async () => {
		// Given: a warm cache and a fresh listing served from it.
		await listRows();
		spyOnPhraseParses();
		const rows = await listRows();

		// When: a non-empty query searches the cache-served rows.
		const matched = filterAndSortSessions(rows, `"${MIDDLE_PHRASE}"`, "recent");

		// Then: the cached transcript text still matches, with no record deserialized.
		expect(matched.map((row) => row.id)).toEqual([SESSION_ID]);
		expect(phraseParseCount).toBe(0);
	});

	it("re-reads the transcript after the session file changes", async () => {
		// Given: a warm cache for the session file.
		await listRows();
		const appendedPhrase = "appended-after-cache-phrase";
		const file = join(sessionDir, `${SESSION_ID}.jsonl`);
		writeMiddlePhraseSession(file, projectDir);
		writeFileSync(file, `${userMessageLine(9001, appendedPhrase)}\n`, { flag: "a" });

		// When: the changed directory is listed again.
		const rows = await listRows();

		// Then: the new text is searchable, so the stale summary was not reused.
		expect(filterAndSortSessions(rows, `"${appendedPhrase}"`, "recent").map((row) => row.id)).toEqual([SESSION_ID]);
	});

	it("keeps every row on an empty query", async () => {
		// Given: listed picker rows.
		const rows = await listRows();

		// When: an empty query filters the listed rows.
		const unfiltered = filterAndSortSessions(rows, "", "recent");

		// Then: every row is kept.
		expect(unfiltered.map((row) => row.id)).toEqual([SESSION_ID]);
	});
});
