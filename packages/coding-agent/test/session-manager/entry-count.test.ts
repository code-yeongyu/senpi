import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadEntriesFromFile,
	SessionManager,
	setSessionEntryLoaderForTesting,
} from "../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

describe("SessionManager entry count", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-entry-count-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("excludes the session header from the count", () => {
		const session = SessionManager.create(tempDir, tempDir);
		expect(session.getEntryCount()).toBe(0);
		session.appendMessage(assistantMsg("ready"));
		expect(session.getEntryCount()).toBe(1);
		expect(session.getEntryCount()).toBe(session.getEntries().length);
	});

	it("keeps the full-history count across compaction trim without loading history", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantMsg("ready"));
		session.appendMessage(userMsg("pruned"));
		const firstKeptEntryId = session.appendMessage(userMsg("kept"));
		for (let i = 0; i < 20; i++) {
			session.appendMessage(userMsg(`turn ${i}`));
		}
		const appendedBeforeCompaction = 23;
		expect(session.getEntryCount()).toBe(appendedBeforeCompaction);

		session.appendCompaction("summary", firstKeptEntryId, 100);

		let loadCount = 0;
		const restoreLoader = setSessionEntryLoaderForTesting((filePath) => {
			loadCount++;
			return loadEntriesFromFile(filePath);
		});
		try {
			// The trimmed mirror drops pre-compaction entries, but the full-history
			// count still covers them plus the compaction entry itself.
			expect(session.getEntryCount()).toBe(appendedBeforeCompaction + 1);
			for (let i = 0; i < 5; i++) {
				expect(session.getEntryCount()).toBe(appendedBeforeCompaction + 1);
			}
			expect(loadCount).toBe(0);

			// Appends after the trim advance the full-history count.
			session.appendCustomEntry("synthetic-event", { turn: 1 });
			for (let i = 0; i < 5; i++) {
				expect(session.getEntryCount()).toBe(appendedBeforeCompaction + 2);
			}
			expect(loadCount).toBe(0);

			// Explicit full-history retrieval still loads once and agrees with the count.
			expect(session.getEntries()).toHaveLength(appendedBeforeCompaction + 2);
			expect(loadCount).toBe(1);
		} finally {
			restoreLoader();
		}
	});

	it("rebuilds the count when reopening or switching sessions", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantMsg("ready"));
		const firstKeptEntryId = session.appendMessage(userMsg("kept"));
		session.appendMessage(userMsg("after"));
		session.appendCompaction("summary", firstKeptEntryId, 100);
		const fullCount = session.getEntryCount();
		const sessionFile = session.getSessionFile();
		assert.ok(sessionFile, "persisted session must have a file path");

		const reopened = SessionManager.open(sessionFile, tempDir);
		expect(reopened.getEntryCount()).toBe(fullCount);

		reopened.newSession();
		expect(reopened.getEntryCount()).toBe(0);

		reopened.setSessionFile(sessionFile);
		expect(reopened.getEntryCount()).toBe(fullCount);
	});

	it("counts only the retained path in a persisted branched session", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantMsg("ready"));
		const firstEntryId = session.appendMessage(userMsg("one"));
		session.appendMessage(userMsg("two"));
		session.appendMessage(userMsg("three"));
		expect(session.getEntryCount()).toBe(4);

		const branchedFile = session.createBranchedSession(firstEntryId);
		expect(branchedFile).toBeDefined();
		expect(session.getEntryCount()).toBe(2);
		expect(session.getEntryCount()).toBe(session.getEntries().length);

		session.appendCustomEntry("synthetic", {});
		expect(session.getEntryCount()).toBe(3);
	});
});
