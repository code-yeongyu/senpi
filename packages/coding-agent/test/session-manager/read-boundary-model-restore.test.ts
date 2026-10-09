import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

// Read boundary (f) of senpi#1989: a session recorded before the rename stores
// the LEGACY provider id in its JSONL. Restoring it must yield the canonical
// id so the user resumes on the same model instead of an unknown provider.
// No rewrite is added here; senpi already rewrites session files elsewhere.
const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0) {
		const d = dirs.pop();
		if (d) rmSync(d, { recursive: true, force: true });
	}
});

function openSession(entries: unknown[]): SessionManager {
	const directory = join(tmpdir(), `read-boundary-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	dirs.push(directory);
	mkdirSync(directory, { recursive: true });
	const file = join(directory, "session.jsonl");
	const head = { type: "session", version: 3, id: "rb", timestamp: "2026-09-22T00:00:00.000Z", cwd: directory };
	writeFileSync(file, `${[head, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`);
	return SessionManager.open(file, directory);
}
const assistant = (id: string, parentId: string | null, provider: string, model: string) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-09-22T00:00:03.000Z",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "hi" }],
		provider,
		model,
		api: "openai-completions",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "stop",
		timestamp: 1,
	},
});

describe("read boundary: session model restore (senpi#1989)", () => {
	it("restores a legacy model_change provider as the canonical id", () => {
		const session = openSession([
			{
				type: "model_change",
				id: "m1",
				parentId: null,
				timestamp: "2026-09-22T00:00:01.000Z",
				provider: "claude-sdk-oauth",
				modelId: "opus",
			},
		]);
		expect(session.buildSessionContext().model).toEqual({ provider: "anthropic-subscription", modelId: "opus" });
	});

	it("restores a legacy assistant-message provider as the canonical id", () => {
		const session = openSession([assistant("a1", null, "openai-codex", "gpt-5.6-sol")]);
		expect(session.buildSessionContext().model).toEqual({ provider: "chatgpt-subscription", modelId: "gpt-5.6-sol" });
	});

	it("restores the legacy ORIGINAL provider when a trailing fallback window is open", () => {
		const session = openSession([
			{
				type: "model_change",
				id: "p",
				parentId: null,
				timestamp: "2026-09-22T00:00:01.000Z",
				provider: "claude-sdk-oauth",
				modelId: "opus",
			},
			{
				type: "model_change",
				id: "f",
				parentId: "p",
				timestamp: "2026-09-22T00:00:02.000Z",
				provider: "fallback",
				modelId: "two",
				reason: "fallback",
				originalProvider: "claude-sdk-oauth",
				originalModelId: "opus",
			},
			assistant("fa", "f", "fallback", "two"),
		]);
		expect(session.buildSessionContext().model).toEqual({ provider: "anthropic-subscription", modelId: "opus" });
	});

	it("keeps an explicit legacy selection from being overridden by the same provider's echo", () => {
		// The explicit selection and the later echo are the SAME lane once
		// normalized, so the explicit modelId must survive the assistant echo.
		const session = openSession([
			{
				type: "model_change",
				id: "m1",
				parentId: null,
				timestamp: "2026-09-22T00:00:01.000Z",
				provider: "anthropic-subscription",
				modelId: "opus",
			},
			assistant("a1", "m1", "claude-sdk-oauth", "opus-wire-id"),
		]);
		expect(session.buildSessionContext().model).toEqual({ provider: "anthropic-subscription", modelId: "opus" });
	});

	it("leaves an untouched provider exactly as recorded", () => {
		const session = openSession([assistant("a1", null, "anthropic", "claude-opus-4")]);
		expect(session.buildSessionContext().model).toEqual({ provider: "anthropic", modelId: "claude-opus-4" });
	});
});
