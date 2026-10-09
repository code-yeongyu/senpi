import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { loadEntriesFromFile, SessionManager, setSessionEntryLoaderForTesting } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

type HookStatusTickerPrototype = {
	startToolHookStatusTimer(this: HookStatusTickerThis): void;
};

type HookStatusTickerThis = {
	hookStatusIntervalId: ReturnType<typeof setInterval> | undefined;
	sessionManager: Pick<SessionManager, "getEntryCount">;
	refreshToolHookStatuses(): void;
};

describe("InteractiveMode hook status ticker", () => {
	test("unrefs the interval handle when starting the hook status ticker", () => {
		// Given
		const prototype = InteractiveMode.prototype as unknown as HookStatusTickerPrototype;
		const intervalHandle = setInterval(() => {}, 60_000);
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(intervalHandle);
		const unrefSpy = vi.spyOn(intervalHandle, "unref");
		const fakeThis: HookStatusTickerThis = {
			hookStatusIntervalId: undefined,
			sessionManager: { getEntryCount: () => 0 },
			refreshToolHookStatuses: vi.fn(),
		};

		try {
			// When
			prototype.startToolHookStatusTimer.call(fakeThis);

			// Then
			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
			expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 32);
			expect(unrefSpy).toHaveBeenCalledTimes(1);
		} finally {
			clearInterval(intervalHandle);
			vi.restoreAllMocks();
		}
	});

	test.each([
		[0, 32],
		[999, 32],
		[1000, 1000],
	])("uses %i entries to select a %i ms cadence", (entryCount, intervalMs) => {
		const prototype = InteractiveMode.prototype as unknown as HookStatusTickerPrototype;
		const intervalHandle = setInterval(() => {}, 60_000);
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(intervalHandle);
		const session = SessionManager.inMemory();
		for (let i = 0; i < entryCount; i++) session.appendCustomEntry("synthetic", { index: i });
		const fakeThis: HookStatusTickerThis = {
			hookStatusIntervalId: undefined,
			sessionManager: session,
			refreshToolHookStatuses: vi.fn(),
		};

		try {
			prototype.startToolHookStatusTimer.call(fakeThis);

			expect(setIntervalSpy).toHaveBeenCalledTimes(1);
			expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), intervalMs);
		} finally {
			clearInterval(intervalHandle);
			vi.restoreAllMocks();
		}
	});

	test("starts the ticker on a trimmed persisted session without loading history", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "hook-status-count-"));
		const intervalHandle = setInterval(() => {}, 60_000);
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockReturnValue(intervalHandle);
		let loadCount = 0;
		const restoreLoader = setSessionEntryLoaderForTesting((filePath) => {
			loadCount++;
			return loadEntriesFromFile(filePath);
		});
		try {
			const session = SessionManager.create(tempDir, tempDir);
			session.appendMessage(assistantMsg("ready"));
			const firstKeptEntryId = session.appendMessage(userMsg("kept"));
			for (let i = 0; i < 998; i++) session.appendMessage(userMsg(`turn ${i}`));
			session.appendCompaction("summary", firstKeptEntryId, 100);
			expect(session.getEntryCount()).toBe(1001);
			const owner: HookStatusTickerThis = {
				sessionManager: session,
				hookStatusIntervalId: undefined,
				refreshToolHookStatuses: vi.fn(),
			};
			const prototype = InteractiveMode.prototype as unknown as HookStatusTickerPrototype;
			prototype.startToolHookStatusTimer.call(owner);
			expect(setIntervalSpy).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 1_000);
			expect(loadCount).toBe(0);
		} finally {
			restoreLoader();
			clearInterval(intervalHandle);
			vi.restoreAllMocks();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
