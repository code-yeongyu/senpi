import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findMostRecentSession, SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager open and lightweight state", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-open-state-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("opens sessions with headers longer than the first read buffer", () => {
		const file = join(tempDir, "long-header.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "long-header",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: tempDir,
				parentSession: "parent-session-".repeat(80),
			})}\n` +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);

		const sessionManager = SessionManager.open(file, tempDir);

		expect(sessionManager.getSessionId()).toBe("long-header");
		expect(sessionManager.getCwd()).toBe(tempDir);
		expect(sessionManager.getEntries()).toHaveLength(1);
	});

	it("opens sessions without preloading non-header entries", () => {
		const file = join(tempDir, "open-once.jsonl");
		const sentinel = "NON_HEADER_SENTINEL_OPEN_ONCE";
		writeFileSync(
			file,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "open-once",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: tempDir,
			})}\n` +
				`${JSON.stringify({
					type: "message",
					id: "1",
					parentId: null,
					timestamp: "2025-01-01T00:00:01Z",
					message: { role: "user", content: sentinel, timestamp: 1 },
				})}\n`,
		);

		const originalParse = JSON.parse;
		let sentinelParses = 0;
		const parseSpy = vi
			.spyOn(JSON, "parse")
			.mockImplementation(
				(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown => {
					if (text.includes(sentinel)) {
						sentinelParses++;
					}
					return originalParse(text, reviver);
				},
			);

		try {
			const sessionManager = SessionManager.open(file, tempDir);

			expect(sessionManager.getSessionId()).toBe("open-once");
			expect(sessionManager.getEntries()).toHaveLength(1);
			expect(sentinelParses).toBe(1);
		} finally {
			parseSpy.mockRestore();
		}
	});

	it("matches cwd for sessions with long headers", () => {
		const project = join(tempDir, "project-long-header");
		const file = join(tempDir, "long-header.jsonl");
		writeFileSync(
			file,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "long-header",
				timestamp: "2025-01-01T00:00:00Z",
				cwd: project,
				parentSession: "parent-session-".repeat(80),
			})}\n` +
				'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n',
		);

		expect(findMostRecentSession(tempDir, project)).toBe(file);
	});

	it("reports context and metadata state from the current branch", () => {
		const session = SessionManager.create(tempDir, tempDir);

		expect(session.hasContextMessages()).toBe(false);
		expect(session.hasThinkingLevelChanges()).toBe(false);
		expect(session.countCompactions()).toBe(0);

		session.appendModelChange("openai", "gpt-test");
		const firstMessageId = session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		session.appendThinkingLevelChange("high");
		session.appendCompaction("summary", firstMessageId, 42);

		expect(session.hasContextMessages()).toBe(true);
		expect(session.hasThinkingLevelChanges()).toBe(true);
		expect(session.countCompactions()).toBe(1);

		session.branch(firstMessageId);

		expect(session.hasContextMessages()).toBe(true);
		expect(session.hasThinkingLevelChanges()).toBe(false);
	});

	it("treats custom-message-only sessions as existing context", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendCustomMessageEntry("test-extension", "extension context", false);

		expect(session.buildSessionContext().messages).toHaveLength(1);
		expect(session.hasContextMessages()).toBe(true);
	});

	it("does not replace a live session when its file is transiently empty", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const file = session.getSessionFile();
		expect(file).toBeDefined();
		const entryId = session.appendMessage({ role: "user", content: "keep me", timestamp: 1 });
		writeFileSync(file!, "");

		session.reloadFromDisk();

		expect(session.getSessionId()).not.toBe("");
		expect(session.getEntry(entryId)?.id).toBe(entryId);
		expect(session.getEntries()).toHaveLength(1);
	});

	it("leaves all state unchanged when a replacement session file is malformed", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const file = session.getSessionFile();
		expect(file).toBeDefined();
		const entryId = session.appendMessage({ role: "user", content: "keep me", timestamp: 1 });
		const originalId = session.getSessionId();
		writeFileSync(file!, '{"type":"not-a-session"}\\n');

		expect(() => session.reloadFromDisk()).toThrow();
		expect(session.getSessionId()).toBe(originalId);
		expect(session.getEntry(entryId)?.id).toBe(entryId);
		expect(session.getEntries()).toHaveLength(1);
	});

	it("reloads entries from disk when session file changes externally", () => {
		const session = SessionManager.create(tempDir, tempDir);
		const file = session.getSessionFile();
		expect(file).toBeDefined();
		expect(session.getEntries()).toHaveLength(0);

		const userEntry = {
			type: "message",
			id: "ext-1",
			parentId: null,
			timestamp: "2025-01-01T00:00:01Z",
			message: { role: "user", content: "hello from outside", timestamp: 1 },
		};
		const compactionEntry = {
			type: "compaction",
			id: "ext-2",
			parentId: "ext-1",
			timestamp: "2025-01-01T00:00:02Z",
			summary: "external compaction",
			firstKeptEntryId: "ext-1",
			tokensBefore: 100,
		};
		const header = {
			type: "session",
			version: 3,
			id: session.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: tempDir,
		};
		appendFileSync(
			file!,
			`${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(compactionEntry)}\n`,
		);

		expect(session.getEntries()).toHaveLength(0);

		session.reloadFromDisk();
		expect(session.getEntries()).toHaveLength(2);
		const contextEntries = session.buildContextEntries();
		expect(contextEntries[0]?.type).toBe("compaction");
		expect(session.getLeafId()).toBe("ext-2");
	});
});
