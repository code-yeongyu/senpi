import type { AssistantMessage } from "@earendil-works/pi-ai";
import type * as FsModule from "fs";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * A full disk fails a write part-way: some bytes of the line land, then ENOSPC. The file must
 * still hold only complete lines afterwards, whether the failed write was an append to a flushed
 * transcript or the exclusive first flush that creates it.
 */

const fault = vi.hoisted(() => ({
	appendKeepBytes: undefined as number | undefined,
	writeFailAtCall: undefined as number | undefined,
	writeCalls: 0,
	closeFails: false,
}));

function noSpace(): Error {
	return Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
}

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof FsModule>();
	return {
		...actual,
		appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
			const [path, data] = args;
			const keep = fault.appendKeepBytes;
			if (keep === undefined || typeof data !== "string") return actual.appendFileSync(...args);
			fault.appendKeepBytes = undefined;
			actual.appendFileSync(path, data.slice(0, keep));
			throw noSpace();
		},
		writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
			const [file, data] = args;
			if (fault.writeFailAtCall === undefined || typeof data !== "string") return actual.writeFileSync(...args);
			fault.writeCalls++;
			if (fault.writeCalls < fault.writeFailAtCall) return actual.writeFileSync(...args);
			fault.writeFailAtCall = undefined;
			actual.writeFileSync(file, data.slice(0, Math.floor(data.length / 2)));
			throw noSpace();
		},
		closeSync: (...args: Parameters<typeof actual.closeSync>) => {
			actual.closeSync(...args);
			if (!fault.closeFails) return;
			fault.closeFails = false;
			throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" });
		},
	};
});

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
	fault.appendKeepBytes = undefined;
	fault.writeFailAtCall = undefined;
	fault.writeCalls = 0;
	fault.closeFails = false;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function newSession(): SessionManager {
	const dir = mkdtempSync(join(tmpdir(), "senpi-append-partial-"));
	tempDirs.push(dir);
	return SessionManager.create(dir, join(dir, "sessions"));
}

function captureError(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

function expectCompleteLinesMatchingMemory(session: SessionManager, file: string): void {
	const text = readFileSync(file, "utf8");
	expect(text.endsWith("\n")).toBe(true);
	const onDisk = text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as { type: string; id: string; parentId?: string | null })
		.filter((entry) => entry.type !== "session");
	const diskIds = new Set(onDisk.map((entry) => entry.id));
	expect(onDisk.filter((entry) => entry.parentId && !diskIds.has(entry.parentId))).toEqual([]);
	expect(session.getEntries().map((entry) => entry.id)).toEqual(onDisk.map((entry) => entry.id));
}

describe("SessionManager after a write that failed part-way", () => {
	it("cuts the partial line an interrupted append left before appending the next entry", () => {
		// Given a flushed transcript
		const session = newSession();
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		session.appendMessage(assistant("hi"));
		const file = session.getSessionFile();
		if (!file) throw new Error("test setup: persisted session has no file");
		// When an append runs out of space after 20 bytes of its line
		fault.appendKeepBytes = 20;
		const error = captureError(() => session.appendCustomEntry("torn", { n: 1 }));
		const tornTail = !readFileSync(file, "utf8").endsWith("\n");
		// And the next append succeeds
		session.appendCustomEntry("after", { n: 2 });
		// Then the failure reached the caller, the fragment is gone, and the next line stands on its own
		expect(error).toMatchObject({ code: "ENOSPC" });
		expect(tornTail).toBe(true);
		expectCompleteLinesMatchingMemory(session, file);
	});

	it("removes a first flush that failed part-way so the next flush can create the file", () => {
		// Given a new session whose setup entry is still buffered in memory (the first user message
		// itself flushes the file since #10000, so a setup entry is what stays buffered)
		const session = newSession();
		session.appendCustomEntry("setup", { n: 0 });
		const file = session.getSessionFile();
		if (!file) throw new Error("test setup: persisted session has no file path");
		// When the first flush (header, setup, user) runs out of space inside the user line
		fault.writeFailAtCall = 3;
		const error = captureError(() => session.appendMessage({ role: "user", content: "lost", timestamp: 1 }));
		const leftBehind = existsSync(file);
		// And the message is appended again once there is space
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		// Then the failed flush left no file behind and the retry wrote one complete transcript
		expect(error).toMatchObject({ code: "ENOSPC" });
		expect(leftBehind).toBe(false);
		expectCompleteLinesMatchingMemory(session, file);
		expect(session.getEntries().map((entry) => entry.type)).toEqual(["custom", "message"]);
	});

	it("still removes a failed first flush and reports the write error when closing the file fails too", () => {
		// Given a new session whose setup entry is still buffered in memory (see above, #10000)
		const session = newSession();
		session.appendCustomEntry("setup", { n: 0 });
		const file = session.getSessionFile();
		if (!file) throw new Error("test setup: persisted session has no file path");
		// When the first flush runs out of space and closing the half-written file fails as well
		fault.writeFailAtCall = 3;
		fault.closeFails = true;
		const error = captureError(() => session.appendMessage({ role: "user", content: "lost", timestamp: 1 }));
		const leftBehind = existsSync(file);
		// And the message is appended again
		session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		// Then the caller got the write error with the close failure beside it, and no file was left behind
		expect(error).toBeInstanceOf(AggregateError);
		expect(error).toMatchObject({ errors: [{ code: "ENOSPC" }, { code: "EIO" }] });
		expect(leftBehind).toBe(false);
		expectCompleteLinesMatchingMemory(session, file);
	});
});
