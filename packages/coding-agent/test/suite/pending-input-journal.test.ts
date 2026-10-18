import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	fsJournalDurability,
	type JournalDurability,
	PendingInputAppendUncertainError,
	PendingInputJournalCorruptError,
	PendingInputJournalError,
	PendingInputJournalGapError,
	PendingInputNotDurableError,
	SessionPendingInputJournal,
} from "../../src/core/pending-input-journal.ts";
import {
	PENDING_INPUT_TRANSITION,
	PendingInputStore,
	PendingInputStoreUnavailableError,
} from "../../src/core/pending-input-store.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

// senpi#3549: the session JSONL is the pending-input journal; admission is on disk before the first message.

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

function sessionDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pending-journal-"));
	dirs.push(dir);
	return dir;
}

const SUBMIT = {
	clientMessageId: "c-1",
	fingerprint: "fp",
	text: "check the logs",
	attachments: [],
	requestedMode: "followUp",
} as const;

const SAMPLE_INPUT = {
	clientMessageId: "c-1",
	fingerprint: "fp",
	handle: { lifetimeId: "life-1", queuedId: "q_1" },
	revision: 1,
	hasEdits: false,
	text: "check the logs",
	attachments: [],
	requestedMode: "followUp",
	phase: "queued",
	attemptCount: 0,
	superseded: [],
	operations: {},
} as const;

async function storeOver(manager: SessionManager, lifetimeId: string): Promise<PendingInputStore> {
	let next = 0;
	return PendingInputStore.open({
		journal: new SessionPendingInputJournal(manager),
		lifetimeId,
		nextQueuedId: () => `q_${++next}`,
	});
}

describe("session pending-input journal", () => {
	it("puts an admission on disk before the session has any message", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		const store = await storeOver(manager, "life-1");

		await store.submit(SUBMIT);

		const file = manager.getSessionFile() ?? "";
		const onDisk = readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(
			onDisk.some(
				(entry) => entry.customType === PENDING_INPUT_TRANSITION && entry.data.input.clientMessageId === "c-1",
			),
		).toBe(true);
	});

	it("rebuilds custody and edits from the file after a reopen", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		const store = await storeOver(manager, "life-1");
		await store.submit(SUBMIT);
		await store.apply("c-1", {
			type: "edit",
			effectId: "e1",
			handle: { lifetimeId: "life-1", queuedId: "q_1" },
			expectedRevision: 1,
			text: "edited",
			attachments: [],
		});

		const reopened = await storeOver(SessionManager.open(manager.getSessionFile() ?? "", dir), "life-2");

		expect(reopened.read("c-1")).toMatchObject({
			status: "admitted",
			projection: { state: "edited", text: "edited", revision: 1 },
		});
	});

	it("syncs the file on every append and its directory once, before the append returns", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		const synced: string[] = [];
		const durability: JournalDurability = {
			syncFile: async (path) => {
				synced.push(`file:${path === manager.getSessionFile()}`);
			},
			syncDirectory: async (path) => {
				synced.push(`dir:${path === dir}`);
			},
		};
		let next = 0;
		const store = await PendingInputStore.open({
			journal: new SessionPendingInputJournal(manager, durability),
			lifetimeId: "life-1",
			nextQueuedId: () => `q_${++next}`,
		});

		await store.submit(SUBMIT);
		expect(synced).toEqual(["file:true", "dir:true"]);
		await store.submit({ ...SUBMIT, clientMessageId: "c-2", fingerprint: "fp2" });
		expect(synced).toEqual(["file:true", "dir:true", "file:true"]);
	});

	it("refuses to count an entry that did not reach the session file", async () => {
		const unflushed = {
			isPersisted: () => true,
			persistHeaderNow: async () => undefined,
			isTranscriptFlushed: () => false,
			getSessionFile: () => "/tmp/never-written.jsonl",
			appendCustomEntry: () => "id",
			getEntries: () => [],
		};
		const journal = new SessionPendingInputJournal(unflushed, {
			syncFile: async () => undefined,
			syncDirectory: async () => undefined,
		});

		await expect(
			journal.append({ type: PENDING_INPUT_TRANSITION, cursor: 1, input: SAMPLE_INPUT }),
		).rejects.toBeInstanceOf(PendingInputNotDurableError);
	});

	it("keeps a session opened without persistence in memory, like the rest of that session", async () => {
		const manager = SessionManager.inMemory();
		const store = await storeOver(manager, "life-1");

		await store.submit(SUBMIT);

		expect(manager.getSessionFile()).toBeUndefined();
		expect(store.read("c-1")).toMatchObject({ status: "admitted" });
	});

	it("refuses a journal with a missing transition, which a skipped corrupt line leaves behind", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		await manager.persistHeaderNow();
		manager.appendCustomEntry(PENDING_INPUT_TRANSITION, {
			type: PENDING_INPUT_TRANSITION,
			cursor: 1,
			input: SAMPLE_INPUT,
		});
		manager.appendCustomEntry(PENDING_INPUT_TRANSITION, {
			type: PENDING_INPUT_TRANSITION,
			cursor: 3,
			input: SAMPLE_INPUT,
		});

		await expect(new SessionPendingInputJournal(manager).read()).rejects.toBeInstanceOf(PendingInputJournalGapError);
	});

	it("drops a tail a crash tore from the file on open, and keeps every committed transition", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		await (await storeOver(manager, "life-1")).submit(SUBMIT);
		const file = manager.getSessionFile() ?? "";
		const committed = readFileSync(file, "utf8");
		appendFileSync(file, `{"type":"custom","customType":"${PENDING_INPUT_TRANSITION}","data":{"cursor":2,"inp`);

		const records = await new SessionPendingInputJournal(SessionManager.open(file, dir)).read();

		expect(records).toHaveLength(1);
		expect(readFileSync(file, "utf8")).toBe(committed);
	});

	it("refuses a corrupt transition in the middle of the file", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		await (await storeOver(manager, "life-1")).submit(SUBMIT);
		const file = manager.getSessionFile() ?? "";
		const later = JSON.stringify({ type: "custom", customType: "other", id: "x1", parentId: null, timestamp: "t" });

		appendFileSync(
			file,
			`{"type":"custom","customType":"${PENDING_INPUT_TRANSITION}","data":{"cursor":2,"inp\n${later}\n`,
		);

		await expect(new SessionPendingInputJournal(SessionManager.open(file, dir)).read()).rejects.toBeInstanceOf(
			PendingInputJournalCorruptError,
		);
	});

	it("refuses a corrupt last transition that was written completely (it ends in a newline)", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		const store = await storeOver(manager, "life-1");
		await store.submit(SUBMIT);
		await store.submit({ ...SUBMIT, clientMessageId: "c-2", fingerprint: "fp2" });
		const file = manager.getSessionFile() ?? "";
		const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
		lines[lines.length - 1] =
			`{"type":"custom","customType":"${PENDING_INPUT_TRANSITION}","data":{"cursor":2,"inp#corrupt`;

		writeFileSync(file, `${lines.join("\n")}\n`);

		await expect(new SessionPendingInputJournal(SessionManager.open(file, dir)).read()).rejects.toBeInstanceOf(
			PendingInputJournalCorruptError,
		);
	});

	it("reopens after a crash tore the last line, writes, and reopens again with every input", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		await (await storeOver(manager, "life-1")).submit(SUBMIT);
		const file = manager.getSessionFile() ?? "";
		appendFileSync(file, `{"type":"custom","customType":"${PENDING_INPUT_TRANSITION}","data":{"cursor":9,"inp`);

		const afterCrash = await storeOver(SessionManager.open(file, dir), "life-2");
		await afterCrash.submit({ ...SUBMIT, clientMessageId: "c-2", fingerprint: "fp2" });
		const again = await storeOver(SessionManager.open(file, dir), "life-3");

		expect(again.read("c-1").status).toBe("admitted");
		expect(again.read("c-2").status).toBe("admitted");
	});

	it("fails a write whose sync failed, refuses further writes, and stays reopenable", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		let syncs = 0;
		const failingSecondSync: JournalDurability = {
			syncFile: async () => {
				syncs += 1;
				if (syncs === 2) throw new Error("EIO");
			},
			syncDirectory: async () => undefined,
		};
		let next = 0;
		const store = await PendingInputStore.open({
			journal: new SessionPendingInputJournal(manager, failingSecondSync),
			lifetimeId: "life-1",
			nextQueuedId: () => `q_${++next}`,
		});
		await store.submit(SUBMIT);

		await expect(store.submit({ ...SUBMIT, clientMessageId: "c-2", fingerprint: "fp2" })).rejects.toBeInstanceOf(
			PendingInputAppendUncertainError,
		);
		await expect(store.submit({ ...SUBMIT, clientMessageId: "c-3", fingerprint: "fp3" })).rejects.toBeInstanceOf(
			PendingInputStoreUnavailableError,
		);
		const reopened = await storeOver(SessionManager.open(manager.getSessionFile() ?? "", dir), "life-2");
		expect(reopened.read("c-1").status).toBe("admitted");
		expect(reopened.read("c-2").status).toBe("admitted");
		expect(reopened.read("c-3").status).toBe("not_admitted");
	});

	it("skips the directory sync on Windows, where a directory handle cannot be flushed", async () => {
		const missing = join(sessionDir(), "no-such-dir");

		await expect(fsJournalDurability("win32").syncDirectory(missing)).resolves.toBeUndefined();
		await expect(fsJournalDurability("darwin").syncDirectory(missing)).rejects.toThrow();
	});

	it("refuses a malformed journal entry instead of treating it as absence", async () => {
		const dir = sessionDir();
		const manager = SessionManager.create(dir, dir);
		await manager.persistHeaderNow();
		manager.appendCustomEntry(PENDING_INPUT_TRANSITION, { type: PENDING_INPUT_TRANSITION, cursor: 1 });

		await expect(new SessionPendingInputJournal(manager).read()).rejects.toBeInstanceOf(PendingInputJournalError);
	});
});
