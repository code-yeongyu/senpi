import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadEntriesFromFile,
	SessionManager,
	setSessionEntryLoaderForTesting,
} from "../../src/core/session-manager.ts";
import { ResidentStringStore } from "../../src/core/session-resident-store.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

const LARGE_TEXT = "x".repeat(1024 * 1024);

describe("SessionManager resident mirror", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-mirror-budget-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps the resident blob cache within its documented budget", () => {
		const session = SessionManager.create(tempDir, tempDir);
		for (let i = 0; i < 70; i++) {
			session.appendCustomEntry("large-result", { payload: `${i}:${LARGE_TEXT}` });
		}

		expect(session.getResidentStoreStats().blobBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
	});

	it("trims pre-compaction mirror entries but reloads them for branching", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantMsg("ready"));
		const prunedEntryId = session.appendMessage(userMsg(LARGE_TEXT));
		const firstKeptEntryId = session.appendMessage(userMsg(LARGE_TEXT));
		session.appendMessage(userMsg(LARGE_TEXT));
		const beforeBlobBytes = session.getResidentStoreStats().blobBytes;

		session.appendCompaction("summary", firstKeptEntryId, 100);

		expect(session.getEntries()).toHaveLength(5);
		expect(session.getResidentStoreStats().blobBytes).toBeLessThan(beforeBlobBytes);

		session.branch(prunedEntryId);
		expect(session.getEntry(prunedEntryId)?.id).toBe(prunedEntryId);
		expect(session.buildSessionContext().messages).toHaveLength(2);
	});

	it("keeps full-history reads separate from the compact context mirror", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantMsg("ready"));
		const firstKeptEntryId = session.appendMessage(userMsg("before"));
		session.appendMessage(assistantMsg("after"));
		session.appendCompaction("summary", firstKeptEntryId, 100);

		let loadCount = 0;
		const restoreLoader = setSessionEntryLoaderForTesting((filePath) => {
			loadCount++;
			return loadEntriesFromFile(filePath);
		});
		try {
			session.getEntries();
			session.getEntries();
			expect(loadCount).toBe(2);
			session.buildSessionContext();
			expect(loadCount).toBe(2);
		} finally {
			restoreLoader();
		}
	});

	it("batches compact-context recovery after resident eviction", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantMsg("ready"));
		for (let i = 0; i < 70; i++) session.appendCustomEntry("large-metadata", { payload: `${i}:${LARGE_TEXT}` });
		const firstKeptEntryId = session.appendMessage(userMsg("before"));
		session.appendMessage(assistantMsg("after"));
		session.appendCompaction("summary", firstKeptEntryId, 100);

		let loadCount = 0;
		const restoreLoader = setSessionEntryLoaderForTesting((filePath) => {
			loadCount++;
			return loadEntriesFromFile(filePath);
		});
		try {
			session.buildContextEntries();
			expect(loadCount).toBe(1);
			expect(session.getResidentStoreStats().blobBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
			const compactCache = (session as unknown as { compactEntriesCache: { entries: unknown[] } })
				.compactEntriesCache;
			expect(JSON.stringify(compactCache.entries)).not.toContain(LARGE_TEXT);
			const firstReadCount = loadCount;
			session.buildContextEntries();
			expect(loadCount - firstReadCount).toBeLessThanOrEqual(1);
		} finally {
			restoreLoader();
		}
	});

	it("resets trimmed state when replacing the session with a branched file", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantMsg("ready"));
		const firstKeptEntryId = session.appendMessage(userMsg("before"));
		session.appendMessage(assistantMsg("after"));
		session.appendCompaction("summary", firstKeptEntryId, 100);
		session.getEntries();

		const branchedFile = session.createBranchedSession(firstKeptEntryId);
		expect(branchedFile).toBeDefined();
		expect(session.getEntries().map((entry) => entry.id)).toEqual([firstKeptEntryId]);
	});

	it("bounds standalone resident stores too", () => {
		const store = new ResidentStringStore();
		for (let i = 0; i < 70; i++) store.externalize(`${i}:${LARGE_TEXT}`);
		expect(store.stats().blobBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
	});
});
