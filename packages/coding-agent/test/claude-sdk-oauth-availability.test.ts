import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.mocked(spawn);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn() };
});

import {
	describeClaudeLane,
	probeAmbientClaudeAuthStatus,
} from "../src/core/extensions/builtin/claude-sdk-oauth/availability.ts";
import {
	overrideExecutableDeps,
	resetExecutableDeps,
} from "../src/core/extensions/builtin/claude-sdk-oauth/executable.ts";

const executable = "/fixture/claude";

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
	overrideExecutableDeps({
		platform: "darwin",
		arch: "arm64",
		env: (name) => (name === "CLAUDE_CODE_EXECUTABLE" ? executable : undefined),
		isFile: (path) => path === executable,
	});
});

afterEach(() => {
	resetExecutableDeps();
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

	// #1541: the probe shares the validating resolver, so a path this process cannot stat is never spawned.
	it("returns false without spawning when no candidate is a file", async () => {
		overrideExecutableDeps({ isFile: () => false });
		await expect(probeAmbientClaudeAuthStatus()).resolves.toBe(false);
		expect(spawnMock).not.toHaveBeenCalled();
	});
});

describe("describeClaudeLane", () => {
	it("reports the same validated executable the query path uses and the host runtime", () => {
		expect(describeClaudeLane()).toEqual({
			runtime: process.versions.bun === undefined ? "node" : "bun",
			executable,
			tried: [executable],
		});
	});

	it("reports every candidate tried when nothing is spawnable", () => {
		overrideExecutableDeps({ isFile: () => false, resolve: (spec) => `/resolved/${spec}` });
		const lane = describeClaudeLane();
		expect(lane.executable).toBeUndefined();
		expect(lane.tried).toEqual([
			executable,
			"/resolved/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
			"claude on PATH (PATH is unset)",
		]);
	});
});
