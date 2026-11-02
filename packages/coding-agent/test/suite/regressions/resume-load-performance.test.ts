import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { clearSessionSummaryCache } from "../../../src/core/session-summary-cache.ts";

const HEADER_TIMESTAMP = "2026-01-15T12:00:00.000Z" as const;
const MESSAGE_TIMESTAMP = "2026-01-15T12:00:01.000Z" as const;
const MESSAGE_TIME_MS = Date.parse(MESSAGE_TIMESTAMP);
const ONE_MESSAGE_CONTENT = "resume-one-message-content" as const;
const SELECTED_SESSION_ID = "resume-selected-session" as const;
const NON_SELECTED_SESSION_ID = "resume-non-selected-session" as const;
const ONE_MESSAGE_SESSION_ID = "resume-one-message-session" as const;
const SELECTED_MESSAGE_COUNT = 5000 as const;
const SENTINEL = "RESUME_LOAD_PERF_SENTINEL_DO_NOT_PARSE" as const;
const FILLER_BEFORE_SENTINEL = 256 as const;
const FILLER_AFTER_SENTINEL = 16 as const;
const TRUNCATED_FINAL_RECORD =
	`{"type":"message","id":"truncated-final","parentId":"msg-${SELECTED_MESSAGE_COUNT}","timestamp":"${MESSAGE_TIMESTAMP}","message":{"role":"user","content":"partial` as const;

type UserMessageLineInput = {
	readonly id: string;
	readonly parentId: string | null;
	readonly content: string;
};

function sessionHeaderLine(id: string, cwd: string): string {
	return JSON.stringify({
		type: "session",
		version: 3,
		id,
		timestamp: HEADER_TIMESTAMP,
		cwd,
	});
}

function userMessageLine(input: UserMessageLineInput): string {
	return JSON.stringify({
		type: "message",
		id: input.id,
		parentId: input.parentId,
		timestamp: MESSAGE_TIMESTAMP,
		message: {
			role: "user",
			content: input.content,
			timestamp: MESSAGE_TIME_MS,
		},
	});
}

function chainedUserMessages(count: number, contentPrefix: string): string[] {
	const lines: string[] = [];
	for (let index = 1; index <= count; index++) {
		lines.push(
			userMessageLine({
				id: `msg-${index}`,
				parentId: index === 1 ? null : `msg-${index - 1}`,
				content: `${contentPrefix}-${index}`,
			}),
		);
	}
	return lines;
}

function writeJsonl(path: string, lines: readonly string[]): void {
	writeFileSync(path, `${lines.join("\n")}\n`);
}

describe("resume session discovery/load performance contract", () => {
	let tempDir: string;
	let projectDir: string;
	let sessionDir: string;

	beforeEach(() => {
		clearSessionSummaryCache();
		tempDir = mkdtempSync(join(tmpdir(), "resume-load-perf-"));
		projectDir = join(tempDir, "project");
		sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
	});

	afterEach(() => {
		clearSessionSummaryCache();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("omits empty and invalid session files from discovery", async () => {
		// Given: empty, malformed, and non-session JSONL files in the session directory.
		writeFileSync(join(sessionDir, "empty.jsonl"), "");
		writeFileSync(join(sessionDir, "invalid.jsonl"), "{this is not json\n");
		writeJsonl(join(sessionDir, "not-a-session.jsonl"), [JSON.stringify({ type: "event", id: "not-a-session" })]);

		// When: SessionManager.list discovers sessions for the project.
		const listed = await SessionManager.list(projectDir, sessionDir);

		// Then: none of the unreadable files become picker rows.
		expect(listed).toEqual([]);
	});

	it("preserves one-message ordering and content on load", () => {
		// Given: a session whose tree is a single user message.
		const file = join(sessionDir, `${ONE_MESSAGE_SESSION_ID}.jsonl`);
		writeJsonl(file, [
			sessionHeaderLine(ONE_MESSAGE_SESSION_ID, projectDir),
			userMessageLine({
				id: "msg-1",
				parentId: null,
				content: ONE_MESSAGE_CONTENT,
			}),
		]);

		// When: SessionManager.open loads that session.
		const session = SessionManager.open(file, sessionDir);

		// Then: the loaded tree is that one message, in order, with the written content.
		const entries = session.getEntries();
		expect(session.getSessionId()).toBe(ONE_MESSAGE_SESSION_ID);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			type: "message",
			id: "msg-1",
			parentId: null,
			timestamp: MESSAGE_TIMESTAMP,
			message: {
				role: "user",
				content: ONE_MESSAGE_CONTENT,
				timestamp: MESSAGE_TIME_MS,
			},
		});
	});

	it("recovers a 5000-message selected session when the final JSONL record is truncated", () => {
		// Given: a selected session with 5000 valid messages and a truncated trailing record.
		const file = join(sessionDir, `${SELECTED_SESSION_ID}.jsonl`);
		writeFileSync(
			file,
			`${[sessionHeaderLine(SELECTED_SESSION_ID, projectDir), ...chainedUserMessages(SELECTED_MESSAGE_COUNT, "selected-message")].join("\n")}\n${TRUNCATED_FINAL_RECORD}\n`,
		);

		// When: SessionManager.open loads the selected session.
		const session = SessionManager.open(file, sessionDir);

		// Then: lenient recovery keeps the 5000 intact messages and drops the truncated tail.
		const entries = session.getEntries();
		expect(session.getSessionId()).toBe(SELECTED_SESSION_ID);
		expect(entries).toHaveLength(SELECTED_MESSAGE_COUNT);
		expect(entries[0]).toMatchObject({
			type: "message",
			id: "msg-1",
			parentId: null,
			message: { role: "user", content: "selected-message-1" },
		});
		expect(entries[SELECTED_MESSAGE_COUNT - 1]).toMatchObject({
			type: "message",
			id: `msg-${SELECTED_MESSAGE_COUNT}`,
			parentId: `msg-${SELECTED_MESSAGE_COUNT - 1}`,
			message: { role: "user", content: `selected-message-${SELECTED_MESSAGE_COUNT}` },
		});
		expect(entries.map((entry) => entry.id)).not.toContain("truncated-final");
	});

	it("does not re-parse a sentinel deep in an unchanged non-selected session on a later list()", async () => {
		// Given: a small selected session and an unchanged non-selected session with a sentinel past the picker preview.
		writeJsonl(join(sessionDir, `${SELECTED_SESSION_ID}.jsonl`), [
			sessionHeaderLine(SELECTED_SESSION_ID, projectDir),
			userMessageLine({
				id: "msg-1",
				parentId: null,
				content: "selected-preview",
			}),
		]);

		const nonSelectedLines = [
			sessionHeaderLine(NON_SELECTED_SESSION_ID, projectDir),
			userMessageLine({
				id: "msg-1",
				parentId: null,
				content: "non-selected-preview",
			}),
			...chainedUserMessages(FILLER_BEFORE_SENTINEL, "filler-before").map((_, index) => {
				const messageIndex = index + 2;
				return userMessageLine({
					id: `msg-${messageIndex}`,
					parentId: `msg-${messageIndex - 1}`,
					content: `filler-before-${index + 1}`,
				});
			}),
		];
		const sentinelIndex = FILLER_BEFORE_SENTINEL + 2;
		nonSelectedLines.push(
			userMessageLine({
				id: `msg-${sentinelIndex}`,
				parentId: `msg-${sentinelIndex - 1}`,
				content: SENTINEL,
			}),
		);
		for (let offset = 1; offset <= FILLER_AFTER_SENTINEL; offset++) {
			const messageIndex = sentinelIndex + offset;
			nonSelectedLines.push(
				userMessageLine({
					id: `msg-${messageIndex}`,
					parentId: `msg-${messageIndex - 1}`,
					content: `filler-after-${offset}`,
				}),
			);
		}
		writeJsonl(join(sessionDir, `${NON_SELECTED_SESSION_ID}.jsonl`), nonSelectedLines);

		// Given: a first listing that has already summarized both unchanged session files.
		await SessionManager.list(projectDir, sessionDir);

		const originalParse = JSON.parse;
		let sentinelParseCount = 0;
		const parseSpy = vi
			.spyOn(JSON, "parse")
			.mockImplementation(
				(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown => {
					if (text.includes(SENTINEL)) {
						sentinelParseCount += 1;
					}
					return originalParse(text, reviver);
				},
			);

		try {
			// When: SessionManager.list repopulates picker rows for the unchanged directory.
			const listed = await SessionManager.list(projectDir, sessionDir);

			// Then: both sessions are discovered, but the non-selected sentinel is not re-parsed.
			expect(listed).toHaveLength(2);
			expect(new Set(listed.map((session) => session.id))).toEqual(
				new Set([SELECTED_SESSION_ID, NON_SELECTED_SESSION_ID]),
			);
			expect(
				sentinelParseCount,
				"SessionManager.list() must not re-parse a sentinel placed deep in an unchanged non-selected session; an unchanged session file must be served from the stat-keyed summary cache",
			).toBe(0);
		} finally {
			parseSpy.mockRestore();
		}
	});
});
