import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	loadEntriesFromFile,
	SessionManager,
	setSessionEntryLoaderForTesting,
} from "../../src/core/session-manager.ts";
import { RESIDENT_STRING_PREFIX, ResidentStringStore } from "../../src/core/session-resident-store.ts";
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
			expect(session.getEntries().map((entry) => entry.type)).toEqual([
				"message",
				"message",
				"message",
				"compaction",
			]);
			// The first full read after the trim is kept and reused, and entries appended since still appear.
			const laterId = session.appendMessage(userMsg("later"));
			expect(
				session
					.getEntries()
					.map((entry) => entry.id)
					.at(-1),
			).toBe(laterId);
			expect(session.getEntries()).toHaveLength(5);
			expect(loadCount).toBe(1);
			session.buildSessionContext();
			expect(loadCount).toBe(1);
		} finally {
			restoreLoader();
		}
	});

	it("recovers compact context from the blob backing after resident eviction", () => {
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
			expect(loadCount).toBe(0);
			expect(session.getResidentStoreStats().blobBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
			const compactCache = (session as unknown as { compactEntriesCache: { entries: unknown[] } })
				.compactEntriesCache;
			expect(JSON.stringify(compactCache.entries)).not.toContain(LARGE_TEXT);
			const firstReadCount = loadCount;
			session.buildContextEntries();
			expect(loadCount - firstReadCount).toBe(0);
		} finally {
			restoreLoader();
		}
	});

	it("recovers evicted entries in getEntries from the blob backing", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantMsg("ready"));
		for (let i = 0; i < 70; i++) {
			session.appendCustomEntry("large-metadata", { payload: `${i}:${LARGE_TEXT}:RESUME_EVICTED_SENTINEL` });
		}

		let loadCount = 0;
		const restoreLoader = setSessionEntryLoaderForTesting((filePath) => {
			loadCount++;
			return loadEntriesFromFile(filePath);
		});
		try {
			const entries = session.getEntries();
			const payloads = entries
				.filter((entry) => entry.type === "custom")
				.map((entry) => (entry.data as { payload: string }).payload);

			expect(payloads).toHaveLength(70);
			expect(payloads[0]).toBe(`0:${LARGE_TEXT}:RESUME_EVICTED_SENTINEL`);
			expect(payloads.at(-1)).toBe(`69:${LARGE_TEXT}:RESUME_EVICTED_SENTINEL`);
			expect(loadCount).toBe(0);
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

	it("bounds standalone resident stores when a backing directory exists", () => {
		const store = new ResidentStringStore({ blobsDir: () => join(tempDir, "standalone-blobs") });
		for (let i = 0; i < 70; i++) store.externalize(`${i}:${LARGE_TEXT}`);
		expect(store.stats().blobBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
	});

	it("keeps sentinel tokens out of the branched session JSONL", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantMsg("ready"));
		for (let i = 0; i < 70; i++) session.appendCustomEntry("large-metadata", { payload: `${i}:${LARGE_TEXT}` });
		const firstKeptEntryId = session.appendMessage(userMsg("before"));
		session.appendMessage(assistantMsg("after"));
		const previousBlobsDir = session.getResidentStore().resolvedBlobsDir();

		const branchedFile = session.createBranchedSession(firstKeptEntryId);
		expect(branchedFile).toBeDefined();
		if (previousBlobsDir) {
			expect(existsSync(previousBlobsDir)).toBe(false);
		}
		const branched = readFileSync(branchedFile!, "utf8");
		expect(branched).not.toContain(RESIDENT_STRING_PREFIX);
		expect(branched).toContain(LARGE_TEXT.slice(0, 64));
	});

	it("removes the blob directory when the session manager is disposed", () => {
		const session = SessionManager.create(tempDir, tempDir);
		for (let i = 0; i < 70; i++) session.appendCustomEntry("large-metadata", { payload: `${i}:${LARGE_TEXT}` });
		const blobsDir = session.getResidentStore().resolvedBlobsDir();
		expect(blobsDir).toBeDefined();
		expect(existsSync(blobsDir!)).toBe(true);

		session.dispose();

		expect(existsSync(blobsDir!)).toBe(false);
	});

	it("clears blobs a dead process left behind when a persisted session is reopened", () => {
		// An assistant message is what flushes the JSONL to disk; without one there
		// is no file for a later process to reopen.
		const previous = SessionManager.create(tempDir, tempDir);
		previous.appendMessage(assistantMsg("ready"));
		for (let i = 0; i < 70; i++) previous.appendCustomEntry("large-metadata", { payload: `${i}:${LARGE_TEXT}` });
		const sessionFile = previous.getSessionFile()!;
		const previousBlobsDir = previous.getResidentStore().resolvedBlobsDir()!;
		// The writer is gone with its process; only its blob directory outlived it.
		previous.dispose();
		mkdirSync(previousBlobsDir, { recursive: true });
		const staleBlob = join(previousBlobsDir, `${"9".repeat(64)}.blob`);
		writeFileSync(staleBlob, JSON.stringify({ v: 1, text: LARGE_TEXT }), "utf8");

		const reopened = SessionManager.open(sessionFile, tempDir);

		expect(existsSync(staleBlob)).toBe(false);
		const payloads = reopened
			.getEntries()
			.filter((entry) => entry.type === "custom")
			.map((entry) => (entry.data as { payload: string }).payload);
		expect(payloads).toHaveLength(70);
		expect(payloads[0]).toBe(`0:${LARGE_TEXT}`);
		expect(payloads.at(-1)).toBe(`69:${LARGE_TEXT}`);
	});

	it("keeps the blob directory while another live manager still owns the session file", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantMsg("ready"));
		for (let i = 0; i < 70; i++) session.appendCustomEntry("large-metadata", { payload: `${i}:${LARGE_TEXT}` });
		const blobsDir = session.getResidentStore().resolvedBlobsDir()!;
		const sessionFile = session.getSessionFile()!;

		// A second manager over the same file (the app-server loads a thread that is
		// already open). Neither its open nor its disposal may take the cache the
		// first manager is still hydrating from.
		const sibling = SessionManager.open(sessionFile, tempDir);
		expect(readdirSync(blobsDir).some((name) => name.endsWith(".blob"))).toBe(true);

		sibling.dispose();

		expect(existsSync(blobsDir)).toBe(true);
		expect(
			session
				.getEntries()
				.filter((entry) => entry.type === "custom")
				.map((entry) => (entry.data as { payload: string }).payload),
		).toHaveLength(70);

		// Once the last owner lets go, the directory goes with it.
		session.dispose();

		expect(existsSync(blobsDir)).toBe(false);
	});

	it("removes the previous session's blob directory on newSession", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantMsg("ready"));
		for (let i = 0; i < 70; i++) session.appendCustomEntry("large-metadata", { payload: `${i}:${LARGE_TEXT}` });
		const previousBlobsDir = session.getResidentStore().resolvedBlobsDir();
		expect(previousBlobsDir).toBeDefined();
		expect(existsSync(previousBlobsDir!)).toBe(true);

		session.newSession();

		expect(existsSync(previousBlobsDir!)).toBe(false);
	});
});
