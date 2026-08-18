import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.mocked(spawn);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn() };
});

import { probeAmbientClaudeAuthStatus } from "../src/core/extensions/builtin/claude-sdk-oauth/availability.ts";

const executable = "C:/fixture/claude.exe";
const previousExecutable = process.env.CLAUDE_CODE_EXECUTABLE;

function fakeChild(outcome: 0 | 1 | "error"): ChildProcess {
	const child = new EventEmitter() as unknown as ChildProcess;
	queueMicrotask(() => {
		if (outcome === "error") {
			child.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
			return;
		}
		child.emit("close", outcome);
	});
	return child;
}

beforeEach(() => {
	spawnMock.mockReset();
	process.env.CLAUDE_CODE_EXECUTABLE = executable;
});

afterEach(() => {
	if (previousExecutable === undefined) {
		delete process.env.CLAUDE_CODE_EXECUTABLE;
		return;
	}
	process.env.CLAUDE_CODE_EXECUTABLE = previousExecutable;
});

describe("readAmbientClaudeAuthStatus", () => {
	it("hides the Claude auth status probe window", async () => {
		spawnMock.mockReturnValue(fakeChild(0));

		await expect(probeAmbientClaudeAuthStatus()).resolves.toBe(true);
		expect(spawnMock).toHaveBeenCalledWith(executable, ["auth", "status"], {
			stdio: "ignore",
			windowsHide: true,
		});
	});

	// readAmbientClaudeAuthStatus memoises its result for 30s, so the outcome cases probe directly:
	// through the reader they would all observe the first `true` this file already cached.
	it("returns false for a non-zero exit", async () => {
		spawnMock.mockReturnValue(fakeChild(1));
		await expect(probeAmbientClaudeAuthStatus()).resolves.toBe(false);
	});

	it("returns false when the probe cannot spawn", async () => {
		spawnMock.mockReturnValue(fakeChild("error"));
		await expect(probeAmbientClaudeAuthStatus()).resolves.toBe(false);
	});
});
