import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	loadEntriesFromFile,
	SessionManager,
	setSessionEntryLoaderForTesting,
} from "../../src/core/session-manager.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

type HookStatusTimerThis = {
	sessionManager: SessionManager;
	hookStatusIntervalId: ReturnType<typeof setInterval> | undefined;
};

type HookStatusTimerPrototype = {
	startToolHookStatusTimer(this: HookStatusTimerThis): void;
};

function startHookStatusTimer(owner: HookStatusTimerThis): void {
	(InteractiveMode.prototype as unknown as HookStatusTimerPrototype).startToolHookStatusTimer.call(owner);
}

describe("SessionManager entry count", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-entry-count-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
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
		expect(sessionFile).toBeDefined();

		const reopened = SessionManager.open(sessionFile!, tempDir);
		expect(reopened.getEntryCount()).toBe(fullCount);

		reopened.newSession();
		expect(reopened.getEntryCount()).toBe(0);

		reopened.setSessionFile(sessionFile!);
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

	it("starts the hook status timer on a trimmed session without loading history", () => {
		const session = SessionManager.create(tempDir, tempDir);
		session.appendMessage(assistantMsg("ready"));
		const firstKeptEntryId = session.appendMessage(userMsg("kept"));
		for (let i = 0; i < 998; i++) {
			session.appendMessage(userMsg(`turn ${i}`));
		}
		session.appendCompaction("summary", firstKeptEntryId, 100);
		expect(session.getEntryCount()).toBe(1001);

		const fakeTimerHandle = { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(fakeTimerHandle);
		let loadCount = 0;
		const restoreLoader = setSessionEntryLoaderForTesting((filePath) => {
			loadCount++;
			return loadEntriesFromFile(filePath);
		});
		try {
			const owner: HookStatusTimerThis = { sessionManager: session, hookStatusIntervalId: undefined };
			startHookStatusTimer(owner);
			const intervalMs = setIntervalSpy.mock.calls.at(-1)?.[1];
			expect(intervalMs).toBe(1_000);
			expect(loadCount).toBe(0);
		} finally {
			restoreLoader();
			setIntervalSpy.mockRestore();
		}
	});

	it("preserves the working-status cadence boundary at 999 and 1000 entries", () => {
		const session = SessionManager.inMemory(tempDir);
		const fakeTimerHandle = { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(fakeTimerHandle);
		try {
			const owner: HookStatusTimerThis = { sessionManager: session, hookStatusIntervalId: undefined };

			startHookStatusTimer(owner);
			expect(setIntervalSpy.mock.calls.at(-1)?.[1]).toBe(32);
			owner.hookStatusIntervalId = undefined;

			for (let i = 0; i < 999; i++) {
				session.appendCustomEntry("synthetic", { index: i });
			}
			startHookStatusTimer(owner);
			expect(setIntervalSpy.mock.calls.at(-1)?.[1]).toBe(32);
			owner.hookStatusIntervalId = undefined;

			session.appendCustomEntry("synthetic", { index: 999 });
			startHookStatusTimer(owner);
			expect(setIntervalSpy.mock.calls.at(-1)?.[1]).toBe(1_000);
			owner.hookStatusIntervalId = undefined;
		} finally {
			setIntervalSpy.mockRestore();
		}
	});
});
