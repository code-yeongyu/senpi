import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	captureAgentCheckpoint,
	persistCheckpoint,
} from "../../../src/core/extensions/builtin/compaction/checkpoint-state.ts";
import type { ExtensionAPI, ExtensionContext } from "../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { assistantMsg, userMsg } from "../../utilities.ts";

const LARGE_TEXT = "x".repeat(256 * 1024);

/**
 * senpi#3110: compaction captures the agent's name while a run is active. On a reopened, compacted session that
 * read went through `getEntries()`, which re-parsed the whole transcript file and kept it as a full-history view
 * until the session settled idle, so a busy task child held roughly four times its transcript while it compacted.
 */
describe("compaction-time agent name read on a reopened compacted session (senpi#3110)", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `3110-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function reopenedCompactedSession(): SessionManager {
		const session = SessionManager.create(dir, dir);
		session.appendMessage(userMsg(`early ${LARGE_TEXT}`));
		session.appendCustomEntry("agent-meta", { agentName: "worker" });
		session.appendMessage(assistantMsg("early answer"));
		const firstKept = session.appendMessage(userMsg("kept"));
		session.appendMessage(assistantMsg("kept answer"));
		session.appendCompaction("summary", firstKept, 1000);
		persistCheckpoint(
			{ activeTools: ["read"], agentName: "worker", timestamp: 42 },
			{ appendEntry: (customType, data) => void session.appendCustomEntry(customType, data) },
		);
		session.appendMessage(userMsg("after"));
		session.appendMessage(assistantMsg("after answer"));
		const reopened = SessionManager.open(session.getSessionFile() ?? "", dir);
		// The session settled idle once after its open, which drops the history the load parsed.
		reopened.dropMaterializedCaches();
		return reopened;
	}

	it("names the agent in a new checkpoint without holding the full history", () => {
		// Given: a reopened compacted session whose open-time history was released at idle.
		const reopened = reopenedCompactedSession();
		const ctx = { sessionManager: reopened, model: undefined } as unknown as ExtensionContext;
		const pi = { getActiveTools: () => ["read"], getThinkingLevel: () => "off" } as unknown as ExtensionAPI;

		// When: the compaction captures the agent's state.
		const captured = captureAgentCheckpoint(pi, ctx);

		// Then: the name is still found, and no full-history view is left held.
		expect(captured.agentName).toBe("worker");
		expect(reopened.holdsMaterializedHistory()).toBe(false);
	});
});
