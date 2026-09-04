import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * A catalog entry that maps to an `upstreamModelId` (a `-fast` priority variant is the common
 * case) persists the UPSTREAM id on every assistant message it produces, because that is the id
 * the request went out with. The user's selection, however, is the catalog id recorded by the
 * `model_change` entry. Resuming must restore the selection, not the wire echo: the base model
 * has no priority tier, so restoring it silently turns fast mode off.
 */
const PROVIDER = "quotio-openai";
const FAST_MODEL_ID = "gpt-5.6-sol-fast";
const UPSTREAM_MODEL_ID = "gpt-5.6-sol";

type Entry = Record<string, unknown>;

const temporaryDirectories: string[] = [];

afterEach(() => {
	while (temporaryDirectories.length > 0) {
		const directory = temporaryDirectories.pop();
		if (directory) rmSync(directory, { recursive: true, force: true });
	}
});

function modelChange(id: string, parentId: string | null, provider: string, modelId: string): Entry {
	return { type: "model_change", id, parentId, timestamp: "2026-09-04T00:00:00.000Z", provider, modelId };
}

function assistantMessage(id: string, parentId: string | null, provider: string, model: string): Entry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-09-04T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: `answer from ${model}` }],
			provider,
			model,
			api: "openai-responses",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function openSession(entries: Entry[]): SessionManager {
	const directory = join(tmpdir(), `upstream-model-id-restore-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	temporaryDirectories.push(directory);
	mkdirSync(directory, { recursive: true });
	const file = join(directory, "session.jsonl");
	const header = {
		type: "session",
		version: 3,
		id: "upstream-model-id-restore",
		timestamp: "2026-09-04T00:00:00.000Z",
		cwd: directory,
	};
	writeFileSync(file, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return SessionManager.open(file, directory);
}

describe("session model restoration with upstream model ids", () => {
	it("keeps the selected -fast catalog variant when assistant messages carry its upstream model id", () => {
		// given: the user selected the -fast variant and every reply echoed the upstream (base) id
		const session = openSession([
			modelChange("select", null, PROVIDER, FAST_MODEL_ID),
			assistantMessage("reply-1", "select", PROVIDER, UPSTREAM_MODEL_ID),
			assistantMessage("reply-2", "reply-1", PROVIDER, UPSTREAM_MODEL_ID),
		]);

		// when / then
		expect(session.buildSessionContext().model).toEqual({ provider: PROVIDER, modelId: FAST_MODEL_ID });
	});

	it("restores the primary -fast selection after a fallback window closes", () => {
		// given: a fallback hop and revert, then more upstream-id replies from the primary
		const session = openSession([
			modelChange("select", null, PROVIDER, FAST_MODEL_ID),
			{
				...modelChange("fallback", "select", "anthropic", "claude-opus-5"),
				reason: "fallback",
				originalProvider: PROVIDER,
				originalModelId: FAST_MODEL_ID,
			},
			assistantMessage("fallback-reply", "fallback", "anthropic", "claude-opus-5"),
			{ ...modelChange("revert", "fallback-reply", PROVIDER, FAST_MODEL_ID), reason: "fallback-revert" },
			assistantMessage("reply", "revert", PROVIDER, UPSTREAM_MODEL_ID),
		]);

		// when / then
		expect(session.buildSessionContext().model).toEqual({ provider: PROVIDER, modelId: FAST_MODEL_ID });
	});

	it("follows a later explicit selection over earlier upstream-id replies", () => {
		// given
		const session = openSession([
			modelChange("select-fast", null, PROVIDER, FAST_MODEL_ID),
			assistantMessage("reply-1", "select-fast", PROVIDER, UPSTREAM_MODEL_ID),
			modelChange("select-base", "reply-1", PROVIDER, UPSTREAM_MODEL_ID),
			assistantMessage("reply-2", "select-base", PROVIDER, UPSTREAM_MODEL_ID),
		]);

		// when / then
		expect(session.buildSessionContext().model).toEqual({ provider: PROVIDER, modelId: UPSTREAM_MODEL_ID });
	});

	it("ignores an incomplete model_change entry instead of treating it as a selection", () => {
		// given: a hand-edited / truncated entry with no model id, then a normal reply
		const session = openSession([
			{ ...modelChange("select", null, PROVIDER, FAST_MODEL_ID), modelId: "" },
			assistantMessage("reply", "select", PROVIDER, UPSTREAM_MODEL_ID),
		]);

		// when / then
		expect(session.buildSessionContext().model).toEqual({ provider: PROVIDER, modelId: UPSTREAM_MODEL_ID });
	});

	it("still restores the last assistant model when the session never recorded a selection", () => {
		// given: a legacy session with no model_change entries at all
		const session = openSession([
			assistantMessage("reply-1", null, "anthropic", "claude-opus-4-8"),
			assistantMessage("reply-2", "reply-1", "anthropic", "claude-opus-5"),
		]);

		// when / then
		expect(session.buildSessionContext().model).toEqual({ provider: "anthropic", modelId: "claude-opus-5" });
	});

	it("still lets an assistant message from another provider override the selection", () => {
		// given: a foreign-provider reply without a recorded switch (legacy / hand-edited sessions)
		const session = openSession([
			modelChange("select", null, PROVIDER, FAST_MODEL_ID),
			assistantMessage("reply", "select", "anthropic", "claude-opus-5"),
		]);

		// when / then
		expect(session.buildSessionContext().model).toEqual({ provider: "anthropic", modelId: "claude-opus-5" });
	});
});
