import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

type EntryLike = Record<string, unknown>;

function openSessionWith(entries: EntryLike[]): SessionManager {
	const directory = join(tmpdir(), `fallback-thinking-restore-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	temporaryDirectories.push(directory);
	mkdirSync(directory, { recursive: true });
	const file = join(directory, "session.jsonl");
	const header = {
		type: "session",
		version: 3,
		id: "fallback-thinking-restore",
		timestamp: "2026-08-16T00:00:00.000Z",
		cwd: directory,
	};
	writeFileSync(file, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return SessionManager.open(file, directory);
}

let clock = 0;
function stamp(): string {
	clock += 1;
	return new Date(Date.UTC(2026, 7, 16, 0, 0, clock)).toISOString();
}

function modelChange(
	id: string,
	parentId: string | null,
	provider: string,
	modelId: string,
	extra: EntryLike = {},
): EntryLike {
	return { type: "model_change", id, parentId, timestamp: stamp(), provider, modelId, ...extra };
}

function thinkingChange(id: string, parentId: string | null, thinkingLevel: string): EntryLike {
	return { type: "thinking_level_change", id, parentId, timestamp: stamp(), thinkingLevel };
}

describe("fallback thinking-level session restoration", () => {
	it("restores the pre-fallback thinking level after a completed fallback window", () => {
		const session = openSessionWith([
			modelChange("primary", null, "primary", "one"),
			thinkingChange("think-high", "primary", "high"),
			modelChange("fallback", "think-high", "fallback", "two", {
				reason: "fallback",
				originalProvider: "primary",
				originalModelId: "one",
			}),
			thinkingChange("think-low", "fallback", "low"),
			modelChange("revert", "think-low", "primary", "one", { reason: "fallback-revert" }),
		]);

		const context = session.buildSessionContext();
		expect(context.model).toEqual({ provider: "primary", modelId: "one" });
		expect(context.thinkingLevel).toBe("high");
	});

	it("restores the pre-fallback thinking level when the process died inside the window", () => {
		const session = openSessionWith([
			modelChange("primary", null, "primary", "one"),
			thinkingChange("think-high", "primary", "high"),
			modelChange("fallback", "think-high", "fallback", "two", {
				reason: "fallback",
				originalProvider: "primary",
				originalModelId: "one",
			}),
			thinkingChange("think-low", "fallback", "low"),
		]);

		const context = session.buildSessionContext();
		expect(context.model).toEqual({ provider: "primary", modelId: "one" });
		expect(context.thinkingLevel).toBe("high");
	});

	it("restores the outermost pre-fallback level across nested fallback windows", () => {
		const session = openSessionWith([
			modelChange("primary", null, "primary", "one"),
			thinkingChange("think-xhigh", "primary", "xhigh"),
			modelChange("fallback-a", "think-xhigh", "fallback", "two", {
				reason: "fallback",
				originalProvider: "primary",
				originalModelId: "one",
			}),
			thinkingChange("think-low", "fallback-a", "low"),
			modelChange("fallback-b", "think-low", "fallback", "three", {
				reason: "fallback",
				originalProvider: "fallback",
				originalModelId: "two",
			}),
			thinkingChange("think-off", "fallback-b", "off"),
			modelChange("revert", "think-off", "primary", "one", { reason: "fallback-revert" }),
		]);

		const context = session.buildSessionContext();
		expect(context.model).toEqual({ provider: "primary", modelId: "one" });
		expect(context.thinkingLevel).toBe("xhigh");
	});

	it("keeps a manual thinking change made after the window closed", () => {
		const session = openSessionWith([
			modelChange("primary", null, "primary", "one"),
			thinkingChange("think-high", "primary", "high"),
			modelChange("fallback", "think-high", "fallback", "two", {
				reason: "fallback",
				originalProvider: "primary",
				originalModelId: "one",
			}),
			thinkingChange("think-low", "fallback", "low"),
			modelChange("revert", "think-low", "primary", "one", { reason: "fallback-revert" }),
			thinkingChange("think-minimal", "revert", "minimal"),
		]);

		expect(session.buildSessionContext().thinkingLevel).toBe("minimal");
	});

	it("keeps a thinking change made inside a window abandoned by a manual model switch", () => {
		const session = openSessionWith([
			modelChange("primary", null, "primary", "one"),
			thinkingChange("think-high", "primary", "high"),
			modelChange("fallback", "think-high", "fallback", "two", {
				reason: "fallback",
				originalProvider: "primary",
				originalModelId: "one",
			}),
			thinkingChange("think-low", "fallback", "low"),
			modelChange("manual", "think-low", "manual", "three"),
		]);

		const context = session.buildSessionContext();
		expect(context.model).toEqual({ provider: "manual", modelId: "three" });
		expect(context.thinkingLevel).toBe("low");
	});

	it("tolerates a fallback entry missing its original model metadata", () => {
		const session = openSessionWith([
			modelChange("primary", null, "primary", "one"),
			thinkingChange("think-high", "primary", "high"),
			modelChange("fallback", "think-high", "fallback", "two", { reason: "fallback" }),
			thinkingChange("think-low", "fallback", "low"),
			modelChange("revert", "think-low", "primary", "one", { reason: "fallback-revert" }),
		]);

		const context = session.buildSessionContext();
		// Model restoration is unchanged: without originalProvider/originalModelId the
		// last non-fallback model entry stands.
		expect(context.model).toEqual({ provider: "primary", modelId: "one" });
		expect(context.thinkingLevel).toBe("high");
	});

	it("ignores a fallback-revert entry with no preceding fallback", () => {
		const session = openSessionWith([
			modelChange("primary", null, "primary", "one"),
			thinkingChange("think-high", "primary", "high"),
			modelChange("revert", "think-high", "primary", "one", { reason: "fallback-revert" }),
			thinkingChange("think-low", "revert", "low"),
		]);

		const context = session.buildSessionContext();
		expect(context.model).toEqual({ provider: "primary", modelId: "one" });
		expect(context.thinkingLevel).toBe("low");
	});

	it("treats an unknown model_change reason as a normal switch", () => {
		const session = openSessionWith([
			modelChange("primary", null, "primary", "one"),
			thinkingChange("think-high", "primary", "high"),
			modelChange("future", "think-high", "fallback", "two", { reason: "future-reason" }),
			thinkingChange("think-low", "future", "low"),
		]);

		const context = session.buildSessionContext();
		expect(context.model).toEqual({ provider: "fallback", modelId: "two" });
		expect(context.thinkingLevel).toBe("low");
	});

	it("uses the in-window level when the window opened before any thinking entry", () => {
		const session = openSessionWith([
			modelChange("primary", null, "primary", "one"),
			modelChange("fallback", "primary", "fallback", "two", {
				reason: "fallback",
				originalProvider: "primary",
				originalModelId: "one",
			}),
			thinkingChange("think-low", "fallback", "low"),
			modelChange("revert", "think-low", "primary", "one", { reason: "fallback-revert" }),
		]);

		const context = session.buildSessionContext();
		expect(context.model).toEqual({ provider: "primary", modelId: "one" });
		// Pre-fallback level was the session default ("off"); the in-window "low" is dropped.
		expect(context.thinkingLevel).toBe("off");
	});
});
