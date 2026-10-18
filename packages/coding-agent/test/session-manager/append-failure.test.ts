import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * A session file that refuses a write (EACCES here; ENOSPC or a removed directory in the field)
 * must not leave the refused entry in memory: the next append would chain onto a parent the
 * file never received, and the transcript loses everything after the break on reload.
 */

interface DiskEntry {
	type: string;
	id: string;
	parentId?: string | null;
}

const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 2,
});

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		chmodSync(dir, 0o755);
		rmSync(dir, { recursive: true, force: true });
	}
});

function flushedSession(): { session: SessionManager; file: string } {
	const dir = mkdtempSync(join(tmpdir(), "senpi-append-failure-"));
	tempDirs.push(dir);
	const session = SessionManager.create(dir, join(dir, "sessions"));
	session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	session.appendMessage(assistant("hi"));
	const file = session.getSessionFile();
	if (!file) throw new Error("test setup: persisted session has no file");
	return { session, file };
}

function diskEntries(file: string): DiskEntry[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as DiskEntry)
		.filter((entry) => entry.type !== "session");
}

function appendAcrossRefusedWrite(
	file: string,
	failing: () => string,
	following: () => string,
): { error: unknown; followingId: string } {
	chmodSync(file, 0o444);
	let error: unknown;
	try {
		failing();
	} catch (caught) {
		error = caught;
	}
	chmodSync(file, 0o644);
	return { error, followingId: following() };
}

function expectConsistent(session: SessionManager, file: string): void {
	const onDisk = diskEntries(file);
	const diskIds = new Set(onDisk.map((entry) => entry.id));
	// Every parent the file names is in the file: the chain survives a reload.
	expect(onDisk.filter((entry) => entry.parentId && !diskIds.has(entry.parentId))).toEqual([]);
	// Memory holds exactly what the file holds, in the same order.
	expect(session.getEntries().map((entry) => entry.id)).toEqual(onDisk.map((entry) => entry.id));
}

describe("SessionManager append after a refused write", () => {
	it("keeps a refused custom entry out of memory so the next entry chains onto the last written one", () => {
		// Given a flushed session whose last written entry is the assistant reply
		const { session, file } = flushedSession();
		const lastWritten = session.getLeafId();
		// When one custom entry is refused by the file and the next one is accepted
		const { error, followingId } = appendAcrossRefusedWrite(
			file,
			() => session.appendCustomEntry("refused", { n: 1 }),
			() => session.appendCustomEntry("accepted", { n: 2 }),
		);
		// Then the caller saw the failure, and the accepted entry is a child of the last written entry
		expect(error).toMatchObject({ code: "EACCES" });
		expect(session.getEntry(followingId)?.parentId).toBe(lastWritten);
		expect(session.getEntries().some((entry) => entry.type === "custom" && entry.customType === "refused")).toBe(
			false,
		);
		expectConsistent(session, file);
	});

	it("keeps a refused message out of memory, its leaf and its usage totals", () => {
		// Given a flushed session and its usage totals
		const { session, file } = flushedSession();
		const lastWritten = session.getLeafId();
		const usageBefore = { ...session.getUsageTotals() };
		// When an assistant reply is refused and the next user message is accepted
		const { error, followingId } = appendAcrossRefusedWrite(
			file,
			() => session.appendMessage(assistant("lost")),
			() => session.appendMessage({ role: "user", content: "next", timestamp: 3 }),
		);
		// Then nothing of the refused reply is left behind in memory
		expect(error).toMatchObject({ code: "EACCES" });
		expect(session.getEntry(followingId)?.parentId).toBe(lastWritten);
		expect(session.getUsageTotals()).toEqual(usageBefore);
		expectConsistent(session, file);
	});

	it("keeps a refused compaction entry out of memory", () => {
		// Given a flushed session
		const { session, file } = flushedSession();
		const [firstKept] = session.getEntries();
		if (!firstKept) throw new Error("test setup: no entries");
		const lastWritten = session.getLeafId();
		// When a compaction entry is refused and a later message is accepted
		const { error, followingId } = appendAcrossRefusedWrite(
			file,
			() => session.appendCompaction("summary", firstKept.id, 1_000),
			() => session.appendMessage({ role: "user", content: "after", timestamp: 3 }),
		);
		// Then no compaction is recorded and the chain runs through the last written entry
		expect(error).toMatchObject({ code: "EACCES" });
		expect(session.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(session.getEntry(followingId)?.parentId).toBe(lastWritten);
		expectConsistent(session, file);
	});

	it("reopens with the whole conversation after a refused rename and a later hand-over entry", () => {
		// Given a flushed session holding a four-message conversation
		const { session, file } = flushedSession();
		session.appendMessage({ role: "user", content: "second question", timestamp: 3 });
		session.appendMessage(assistant("second answer"));
		const conversation = session.buildSessionContext().messages.length;
		// When a rename is refused by the file and a later metadata entry is written
		const { error } = appendAcrossRefusedWrite(
			file,
			() => session.appendSessionInfo("refused"),
			() => session.appendCustomEntry("session_released", { reason: "hand-over" }),
		);
		// Then opening the file again shows every message on the branch that ends at the new entry
		expect(error).toMatchObject({ code: "EACCES" });
		const reopened = SessionManager.open(file);
		expect(reopened.getBranch().map((entry) => entry.id)).toEqual(session.getEntries().map((entry) => entry.id));
		expect(reopened.buildSessionContext().messages).toHaveLength(conversation);
		expect(conversation).toBe(4);
	});

	it("keeps a refused session name out of the name cache", () => {
		// Given a flushed, named session
		const { session, file } = flushedSession();
		session.appendSessionInfo("kept");
		// When a rename is refused by the file
		const { error } = appendAcrossRefusedWrite(
			file,
			() => session.appendSessionInfo("refused"),
			() => session.appendCustomEntry("after"),
		);
		// Then the session still reports the name the file holds
		expect(error).toMatchObject({ code: "EACCES" });
		expect(session.getSessionName()).toBe("kept");
		expectConsistent(session, file);
	});
});
