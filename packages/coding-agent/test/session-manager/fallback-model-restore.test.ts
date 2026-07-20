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

function openFallbackSession(reason: string): SessionManager {
	const directory = join(tmpdir(), `fallback-model-restore-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	temporaryDirectories.push(directory);
	mkdirSync(directory, { recursive: true });
	const file = join(directory, "session.jsonl");
	const entries = [
		{ type: "session", version: 3, id: "fallback-restore", timestamp: "2026-07-20T00:00:00.000Z", cwd: directory },
		{
			type: "model_change",
			id: "primary",
			parentId: null,
			timestamp: "2026-07-20T00:00:01.000Z",
			provider: "primary",
			modelId: "one",
		},
		{
			type: "model_change",
			id: "fallback",
			parentId: "primary",
			timestamp: "2026-07-20T00:00:02.000Z",
			provider: "fallback",
			modelId: "two",
			reason,
			originalProvider: "primary",
			originalModelId: "one",
		},
		{
			type: "message",
			id: "fallback-answer",
			parentId: "fallback",
			timestamp: "2026-07-20T00:00:03.000Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "fallback response" }],
				provider: "fallback",
				model: "two",
				api: "openai-completions",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
				stopReason: "stop",
				timestamp: 1,
			},
		},
	];
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return SessionManager.open(file, directory);
}

describe("fallback model session restoration", () => {
	it("uses the primary model when a trailing fallback window contains assistant messages", () => {
		const session = openFallbackSession("fallback");

		expect(session.buildSessionContext().model).toEqual({ provider: "primary", modelId: "one" });
	});

	it("tolerates unknown reason values in forward-compatible session files", () => {
		const session = openFallbackSession("future-reason");

		expect(session.buildSessionContext().model).toEqual({ provider: "fallback", modelId: "two" });
	});
});
